import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Remove only an independently owned neighboring diagram/caption strip.
// Preserve all scalar source/mapping diagnostics and every retained old pixel.
import assert from 'node:assert/strict'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { MAX_SCALE, MAX_EDGE, getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
import { captureNativeTableCropWitness as capture } from './literature-pdf-native-table-crop-witness.mjs'
import {
  nativePageTextPacketInventory,
  createNativeSingleClosingTablePixelEvidence,
  nativeSingleClosingTablePixelEvidenceData
} from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  compact = (s) => s.normalize('NFD').replace(/\s/gu, ''),
  valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6)),
  over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ],
  states = new WeakMap()
function captionRecords(c, records) {
  const rows = records.filter((r) => over(r.sourceRect, c.rect))
  if (
    !rows.length ||
    rows.some((r) => !r.horizontalComplete) ||
    compact(rows.map((r) => r.text).join('')) !==
      compact(Array.isArray(c.lines) ? c.lines.join(' ') : c.text)
  )
    return
  const box = union(rows.map((r) => r.sourceRect))
  if (!box.every((x, i) => Math.abs(x - c.rect[i]) < 1e-6)) return
  return rows
}
export function proveNativeTableCaptionStrip(table, rules, context, options) {
  const panel = proveIndependentPanelTitle(table, rules, context, options)
  if (panel) return panel
  const footer = proveRuledTerminalPixels(table, rules, context, options)
  if (footer) return footer
  const diagonal = proveDiagonalHeaderBody(table, rules, context, options)
  if (diagonal) return diagonal
  const single = proveSingleClosingBody(table, rules, context, options)
  if (single) return single
  const ruled = proveRuledBody(table, rules, context, options)
  if (ruled) return ruled
  const unreliableSingle = proveUnreliableSingleClosingBody(table, rules, context, options)
  if (unreliableSingle) return unreliableSingle
  const railPeer = proveRailPeerBody(table, rules, context, options)
  if (railPeer) return railPeer
  try {
    const { captions, otherFigures, competingRects } = options,
      n = context.nativeGlyphContext,
      v = context.viewport,
      scale = v.scale,
      old = table.cropRect?.map((x) => x / scale)
    assert(
      n &&
        valid(old) &&
        scale > 0 &&
        v.rotation === 0 &&
        v.width === n.viewport.width * scale &&
        v.height === n.viewport.height * scale &&
        same(v.transform, [scale, 0, 0, -scale, 0, v.height])
    )
    assert(
      table.sourceViewport?.width === v.width &&
        table.sourceViewport.height === v.height &&
        table.sourceViewport.scale === scale &&
        !table.parts &&
        !table.cropRects &&
        table.clipped?.length === 0 &&
        table.unassigned?.length === 0 &&
        (!table.notes || !table.notes.length)
    )
    assert(
      table.caption?.page === table.page &&
        valid(table.caption.rect) &&
        !table.caption.regions &&
        table.caption.rect[3] < old[1]
    )
    assert(
      captions.filter(
        (c) =>
          c.page === table.page &&
          same(c.rect, table.caption.rect) &&
          compact(c.text ?? c.lines.join(' ')) === compact(table.caption.text)
      ).length === 1
    )
    const figures = otherFigures.filter(
      (f) =>
        f.page === table.page &&
        f.caption?.page === table.page &&
        valid(f.caption.rect) &&
        over(f.caption.rect, old)
    )
    assert(figures.length === 1)
    const witness = capture(table, context, options)
    assert(witness)
    const { records, glyphs, e } = witness,
      ownCaption = captionRecords(table.caption, records),
      foreignCaption = figures[0].caption,
      foreignCaptionRecords = captionRecords(foreignCaption, records)
    assert(
      ownCaption &&
        foreignCaptionRecords &&
        foreignCaption.rect[2] < table.caption.rect[0] &&
        captions.filter(
          (c) =>
            c.page === table.page &&
            same(c.rect, foreignCaption.rect) &&
            compact(c.text ?? c.lines.join(' ')) === compact(foreignCaption.lines.join(' '))
        ).length === 1
    )
    const claims = new Set()
    for (const cell of table.cells) {
      assert(
        !cell.sourceSegments?.length &&
          Array.isArray(cell.sourceRects) &&
          cell.sourceRects.length === (cell.sourceItems?.length ?? 0)
      )
      for (const [s, owner] of (cell.sourceItems ?? []).entries()) {
        const record = records.find((r) => r.index === owner.index)
        assert(
          record &&
            record.horizontalComplete &&
            owner.pageNumber === table.page &&
            owner.text === record.text &&
            !claims.has(owner.index) &&
            record.sourceRect
              .map((x) => x * scale)
              .every((x, i) => Math.abs(x - cell.sourceRects[s][i]) < 1e-6)
        )
        claims.add(owner.index)
      }
    }
    assert(claims.size && claims.size <= 4096 && claims.size === table.selectedTextItems)
    const owned = records.filter((r) => claims.has(r.index)),
      foreign = records.filter((r) => !claims.has(r.index))
    assert(owned.length === claims.size)
    const groups = new Map()
    for (const rule of rules) {
      if (
        rule[1] !== rule[3] ||
        rule[0] <= table.cropRect[0] ||
        rule[2] >= table.cropRect[2] ||
        rule[1] <= table.caption.rect[3] * scale ||
        rule[1] >= table.cropRect[3] ||
        rule[2] - rule[0] < 0.8 * (table.cropRect[2] - table.cropRect[0])
      )
        continue
      const key = rule[0] + ':' + rule[2]
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(rule)
    }
    const families = [...groups.values()].filter((g) => g.length === 3)
    assert(families.length === 1)
    const rails = families[0].sort((a, b) => a[1] - b[1]),
      railPaint = rails.map((r) => context.rulePaintBounds.get(r.join(','))?.map((x) => x / scale))
    assert(railPaint.every(valid))
    assert(
      owned.every(
        (r) =>
          r.ink[0] >= railPaint[0][0] && r.ink[1] > railPaint[0][3] && r.ink[3] < railPaint[2][1]
      )
    )
    const rasterScale = Math.min(MAX_SCALE, MAX_EDGE / Math.max(old[2] - old[0], old[3] - old[1])),
      left = Math.floor(
        (Math.min(
          ...railPaint.map((r) => r[0]),
          ...owned.map((r) => r.ink[0]),
          ...owned.map((r) => r.advance[0])
        ) -
          1 / rasterScale -
          old[0]) *
          rasterScale
      ),
      top = Math.floor(
        (Math.min(
          ...railPaint.map((r) => r[1]),
          ...owned.map((r) => r.ink[1]),
          ...owned.map((r) => r.advance[1])
        ) -
          1 / rasterScale -
          old[1]) *
          rasterScale
      )
    assert(left > 0 && top <= 0)
    const cropRect = [
        table.cropRect[0] + (left / rasterScale) * scale,
        table.cropRect[1] + (top / rasterScale) * scale,
        table.cropRect[2],
        table.cropRect[3]
      ],
      nativeCrop = cropRect.map((x) => x / scale)
    const expand = (r) => [
      r[0] - 1 / rasterScale,
      r[1] - 1 / rasterScale,
      r[2] + 1 / rasterScale,
      r[3] + 1 / rasterScale
    ]
    assert(nativeCrop[1] > table.caption.rect[3])
    assert(
      valid(nativeCrop) &&
        Math.min(
          MAX_SCALE,
          MAX_EDGE / Math.max(nativeCrop[2] - nativeCrop[0], nativeCrop[3] - nativeCrop[1])
        ) === rasterScale &&
        owned.every(
          (r) =>
            inside(nativeCrop, expand(r.ink)) &&
            inside(nativeCrop, expand(r.advance)) &&
            inside(nativeCrop, expand(r.sourceRect))
        )
    )
    const ownPaths = [],
      foreignPaths = []
    for (const g of n.graphicsBounds) {
      const coarse = g.normalizedRect.map(
        (x, i) => x * (i % 2 ? n.viewport.height : n.viewport.width)
      )
      if (!over(coarse, nativeCrop)) {
        foreignPaths.push({ operationIndex: g.operationIndex, rect: coarse })
        continue
      }
      const a = n.operators.argsArray[g.operationIndex],
        s = e.paths.get(g.operationIndex),
        q = Array.from(a?.[1]?.[0] ?? []),
        m = Util.transform(n.viewport.transform, s.transform)
      assert(
        a[0] === OPS.stroke &&
          q.length === 6 &&
          q[0] === 0 &&
          q[3] === 1 &&
          q.every(Number.isFinite) &&
          m[1] === 0 &&
          m[2] === 0 &&
          m[0] > 0 &&
          m[3] === -m[0] &&
          s.lineCap === 0 &&
          s.solidStroke === true &&
          s.strokeAlpha === 1 &&
          valid(s.clip) &&
          s.lineWidth > 0
      )
      const a1 = [q[1], q[2]],
        a2 = [q[4], q[5]]
      Util.applyTransform(a1, m)
      Util.applyTransform(a2, m)
      assert(a1[1] === a2[1])
      const ink = [
        Math.min(a1[0], a2[0]),
        a1[1] - (s.lineWidth * m[0]) / 2,
        Math.max(a1[0], a2[0]),
        a1[1] + (s.lineWidth * m[0]) / 2
      ]
      assert(
        inside(nativeCrop, expand(ink)) &&
          inside(s.clip, ink) &&
          ink[0] >= railPaint[0][0] &&
          ink[1] >= railPaint[0][1] &&
          ink[3] <= railPaint[2][3]
      )
      ownPaths.push({ operationIndex: g.operationIndex, ink })
    }
    assert(
      railPaint.every((r) => ownPaths.some((p) => p.ink.every((x, i) => Math.abs(x - r[i]) < 1e-6)))
    )
    const foreignCaptionSet = new Set(foreignCaptionRecords.map((r) => r.index)),
      removedForeign = foreign.filter((r) => over(r.ink, old))
    assert(removedForeign.length && removedForeign.every((r) => foreignCaptionSet.has(r.index)))
    assert(foreign.every((r) => !over(r.ink, nativeCrop)))
    // A complete, balanced native drawing group immediately precedes the full
    // independently owned caption. No source or physical claim is inferred from a word prefix.
    const stack = [],
      nativeGroups = []
    for (const [i, op] of n.operators.fnArray.entries()) {
      if (op === OPS.beginGroup) stack.push(i)
      if (op === OPS.endGroup) {
        const start = stack.pop(),
          a = n.operators.argsArray[start][0]
        assert(same(a, n.operators.argsArray[i][0]))
        const first = [...e.paths.keys()].find((p) => p > start && p < i)
        if (
          first === undefined ||
          a.matrix !== null ||
          a.smask !== null ||
          a.isolated !== false ||
          a.knockout !== false ||
          !valid(a.bbox)
        )
          continue
        if (n.operators.fnArray.slice(start + 1, first).some((o) => o === OPS.transform)) continue
        const matrix = Util.transform(n.viewport.transform, e.paths.get(first).transform)
        if (matrix[1] !== 0 || matrix[2] !== 0 || matrix[0] <= 0 || matrix[3] !== -matrix[0])
          continue
        const points = [
          [a.bbox[0], a.bbox[1]],
          [a.bbox[2], a.bbox[3]]
        ]
        for (const p of points) Util.applyTransform(p, matrix)
        const box = [points[0][0], points[1][1], points[1][0], points[0][1]]
        nativeGroups.push({ start, end: i, box })
      }
    }
    assert(stack.length === 0)
    const removedPaths = foreignPaths.filter((p) => over(p.rect, old)),
      nearGroups = nativeGroups.filter(
        (g) =>
          Math.abs(g.box[0] - foreignCaption.rect[0]) < 1e-6 &&
          g.box[2] <= foreignCaption.rect[2] &&
          g.box[3] < foreignCaption.rect[1] &&
          foreignCaption.rect[1] - g.box[3] <=
            foreignCaptionRecords[0].sourceRect[3] - foreignCaptionRecords[0].sourceRect[1] &&
          removedPaths.every((p) => p.operationIndex > g.start && p.operationIndex < g.end) &&
          owned.every((r) => r.glyphOperations.every((i) => i < g.start || i > g.end))
      )
    assert(removedPaths.length && nearGroups.length === 1)
    // A foreign shading style is accepted only inside a balanced graphics save
    // whose entire potentially affected paint is outside both original and new crops.
    const patternScopes = witness.foreignShadingScopes
    assert(
      patternScopes.every(
        (s) =>
          s.restore < Math.min(...owned.flatMap((r) => r.glyphOperations)) &&
          !over(s.paintBounds, old) &&
          !over(s.paintBounds, nativeCrop)
      )
    )
    const width = nativeCrop[2] - nativeCrop[0],
      height = nativeCrop[3] - nativeCrop[1],
      pixelWidth = Math.ceil(width * rasterScale),
      pixelHeight = Math.ceil(height * rasterScale),
      lower =
        Math.max((pixelWidth - 1) / width, (pixelHeight - 1) / height) * (1 - 8 * Number.EPSILON),
      protection = [
        nativeCrop[0] - 1 / lower,
        nativeCrop[1] - 1 / lower,
        nativeCrop[0] + pixelWidth / lower + 1 / lower,
        nativeCrop[1] + pixelHeight / lower + 1 / lower
      ]
    assert(patternScopes.every((s) => inside(s.exclusionBand, protection)))
    assert(
      [
        ...foreign.map((r) => r.ink),
        ...foreignPaths.map((p) => p.rect),
        ...captions.map((c) => c.rect),
        ...competingRects
      ].every((r) => valid(r) && !over(r, protection))
    )
    const opaque = glyphs.filter((g) => !compact(g.text) && valid(g.ink))
    assert(opaque.every((g) => !over(g.ink, nativeCrop)))
    const proof = {
        cropRect,
        nativeCrop,
        oldNativeCrop: old,
        left,
        top,
        rasterScale,
        pixelWidth,
        pixelHeight,
        bounds: { width: n.viewport.width, height: n.viewport.height },
        addedPaint: ownPaths.filter((p) => p.ink[1] < old[1]).map((p) => p.ink),
        sourceItems: [...claims],
        removedFigureCaptionOwners: [...foreignCaptionSet],
        removedPathOperations: removedPaths.map((p) => p.operationIndex),
        foreignGroup: nearGroups[0],
        patternScopes,
        removedPaintRects: [
          ...foreignCaptionRecords.map((r) => r.ink),
          ...removedPaths.map((p) => p.rect)
        ].map(expand)
      },
      proofValue = JSON.stringify(proof),
      refs = [...rules, captions, otherFigures, competingRects],
      otherValue = JSON.stringify({ rules, captions, otherFigures, competingRects }),
      current = () =>
        witness.current() &&
        JSON.stringify(proof) === proofValue &&
        rules.every((r, i) => r === refs[i]) &&
        JSON.stringify({ rules, captions, otherFigures, competingRects }) === otherValue
    states.set(proof, { table, current })
    return proof
  } catch {
    return
  }
}
export async function renderNativeTableCaptionStrip(proof, renderCrop) {
  if (['ruled-body', 'single-closing-body', 'rail-peer-body'].includes(states.get(proof)?.kind))
    return renderRuledBody(proof, renderCrop)
  try {
    const state = states.get(proof)
    if (!state?.current()) return
    const oldPng = await renderCrop(proof.oldNativeCrop)
    if (!state.current()) return
    const oldBytes = Uint8Array.from(oldPng)
    const fullPng = await renderCrop(proof.nativeCrop)
    if (
      !state.current() ||
      oldPng.length !== oldBytes.length ||
      !oldPng.every((x, i) => x === oldBytes[i])
    )
      return
    const fullBytes = Uint8Array.from(fullPng),
      imagesCurrent = () =>
        oldPng.length === oldBytes.length &&
        fullPng.length === fullBytes.length &&
        oldPng.every((x, i) => x === oldBytes[i]) &&
        fullPng.every((x, i) => x === fullBytes[i])
    const a = await loadImage(oldPng)
    if (!state.current() || !imagesCurrent()) return
    const b = await loadImage(fullPng)
    if (!state.current() || !imagesCurrent()) return
    assert(
      b.width === proof.pixelWidth &&
        b.height === proof.pixelHeight &&
        a.width - proof.left === b.width &&
        a.height - proof.top === b.height
    )
    const canvas = createCanvas(b.width, b.height),
      ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    if (proof.top < 0) ctx.drawImage(b, 0, 0, b.width, -proof.top, 0, 0, b.width, -proof.top)
    ctx.drawImage(
      a,
      proof.left,
      0,
      a.width - proof.left,
      a.height,
      0,
      -proof.top,
      a.width - proof.left,
      a.height
    )
    const rgba = ctx.getImageData(0, 0, b.width, b.height).data,
      oldCanvas = createCanvas(a.width, a.height),
      oldCtx = oldCanvas.getContext('2d')
    oldCtx.drawImage(a, 0, 0)
    const oldRgba = oldCtx.getImageData(0, 0, a.width, a.height).data
    for (let y = 0; y < a.height; y++)
      for (let x = 0; x < b.width; x++) {
        const p = y * a.width + x + proof.left,
          q = (y - proof.top) * b.width + x
        assert([0, 1, 2, 3].every((k) => oldRgba[p * 4 + k] === rgba[q * 4 + k]))
      }
    for (let y = 0; y < a.height; y++)
      for (let x = 0; x < proof.left; x++) {
        const p = y * a.width + x
        if ([0, 1, 2, 3].every((k) => oldRgba[p * 4 + k] === 255)) continue
        const cell = [
          proof.oldNativeCrop[0] + x / proof.rasterScale,
          proof.oldNativeCrop[1] + y / proof.rasterScale,
          proof.oldNativeCrop[0] + (x + 1) / proof.rasterScale,
          proof.oldNativeCrop[1] + (y + 1) / proof.rasterScale
        ]
        assert(proof.removedPaintRects.some((r) => over(r, cell)))
      }
    const allowed = proof.addedPaint.map((r) => [
      (r[0] - proof.nativeCrop[0]) * proof.rasterScale - 1,
      (r[1] - proof.nativeCrop[1]) * proof.rasterScale - 1,
      (r[2] - proof.nativeCrop[0]) * proof.rasterScale + 1,
      (r[3] - proof.nativeCrop[1]) * proof.rasterScale + 1
    ])
    for (let y = 0; y < -proof.top; y++)
      for (let x = 0; x < b.width; x++) {
        const q = y * b.width + x
        if ([0, 1, 2, 3].every((k) => rgba[q * 4 + k] === 255)) continue
        assert(allowed.some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]))
      }
    const png = canvas.toBuffer('image/png')
    canvas.width = canvas.height = oldCanvas.width = oldCanvas.height = 1
    assert(getPdfCropRasterProtectionFromPng(png, proof.nativeCrop, proof.bounds))
    if (!state.current() || !imagesCurrent()) return
    state.png = png
    state.pngBytes = Uint8Array.from(png)
    return png
  } catch {
    return
  }
}
export function commitNativeTableCaptionStrip(proof, png) {
  try {
    const state = states.get(proof)
    if (
      !state?.current() ||
      state.png !== png ||
      png.length !== state.pngBytes.length ||
      !png.every((x, i) => x === state.pngBytes[i])
    )
      return
    return {
      ...state.table,
      cropRect: [...proof.cropRect],
      region: proof.cropRect.map(
        (x, i) => x / (i % 2 ? state.table.sourceViewport.height : state.table.sourceViewport.width)
      )
    }
  } catch {
    return
  }
}

// A panel label is only a candidate. Its whole native occurrence, independent
// three-rule body and complete foreign paint inventory establish the crop.
// No source, cell or diagnostic is added by this physical-only certificate.
function proveIndependentPanelTitle(table, rules, context, options) {
  try {
    const n = context.nativeGlyphContext,
      v = context.viewport,
      { page, nativePage, nativeContent, captions, competingRects, otherFigures } = options,
      old = table.cropRect?.map((x) => x / v.scale),
      sourceContent = context.sourceContent
    assert(
      n &&
        valid(old) &&
        v.scale > 0 &&
        v.rotation === 0 &&
        !table.parts &&
        !table.cropRects &&
        !table.notes?.length
    )
    assert(
      v.width === n.viewport.width * v.scale &&
        v.height === n.viewport.height * v.scale &&
        same(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) &&
        table.sourceViewport?.width === v.width &&
        table.sourceViewport.height === v.height &&
        table.sourceViewport.scale === v.scale
    )
    assert(Array.isArray(captions) && Array.isArray(competingRects) && Array.isArray(otherFigures))
    // This narrow admission avoids a whole-page font witness for ordinary tables.
    assert(n.content.items.some((r) => /^Panel [A-Z]:\s+\S/u.test(r.str)))
    const witness = capture(table, context, options, 'foreign-raster-footer')
    assert(witness && !witness.patternOperations.length)
    const { records, glyphs, e } = witness,
      paths = [...e.paths.keys()]
        .filter((i) => ![OPS.endPath, OPS.clip, OPS.eoClip].includes(n.operators.argsArray[i]?.[0]))
        .map((i) => ruledPath(n, e, i)),
      horizontal = paths.filter((p) => p.points.length === 2 && p.points[0][1] === p.points[1][1]),
      families = []
    for (const p of horizontal) {
      const group = horizontal
        .filter(
          (q) =>
            Math.abs(q.ink[0] - p.ink[0]) < 1e-6 &&
            Math.abs(q.ink[2] - p.ink[2]) < 1e-6 &&
            q.ink[3] >= old[1] &&
            q.ink[1] <= old[3]
        )
        .sort((a, b) => a.ink[1] - b.ink[1])
      if (
        group.length === 3 &&
        !families.some((g) => g[0] === group[0]) &&
        group.every(
          (q) =>
            q.ink[0] >= old[0] && q.ink[2] <= old[2] && q.ink[3] >= old[1] && q.ink[1] <= old[3]
        )
      )
        families.push(group)
    }
    assert(families.length === 1)
    const bars = families[0],
      frame = [bars[0].ink[0], bars[0].ink[3], bars[0].ink[2], bars[2].ink[1]],
      body = records.filter((r) => over(r.sourceRect, frame)),
      titles = records.filter(
        (r) =>
          /^Panel [A-Z]:\s+\S/u.test(r.text) &&
          r.sourceRect[3] < bars[0].ink[1] &&
          r.sourceRect[0] >= frame[0] &&
          r.sourceRect[2] <= frame[2] &&
          bars[0].ink[1] - r.sourceRect[3] <= r.sourceRect[3] - r.sourceRect[1]
      )
    assert(titles.length === 1 && body.length > 1)
    const title = titles[0],
      owned = [...body, title],
      byIndex = new Map(body.map((r) => [r.index, r])),
      claims = new Set()
    assert(title.sourceRect[1] < old[1] && owned.every((r) => r.horizontalComplete && valid(r.ink)))
    assert(body.every((r) => inside(frame, r.ink) && inside(old, r.sourceRect)))
    assert(
      body.some((r) => r.ink[3] < bars[1].ink[1]) && body.some((r) => r.ink[1] > bars[1].ink[3])
    )
    for (const cell of table.cells) {
      assert(
        !cell.sourceSegments?.length &&
          (cell.sourceItems?.length ?? 0) === (cell.sourceRects?.length ?? 0)
      )
      for (const [i, s] of (cell.sourceItems ?? []).entries()) {
        const r = byIndex.get(s.index)
        assert(
          r &&
            s.pageNumber === table.page &&
            s.text === r.text &&
            !claims.has(s.index) &&
            same(tableTextToken(sourceContent.items[s.index], v, 0).rect, cell.sourceRects[i])
        )
        claims.add(s.index)
      }
    }
    assert(claims.size === body.length)
    const ownOps = new Set(owned.flatMap((r) => r.glyphOperations)),
      ownPaths = new Set(bars.map((b) => b.operationIndex))
    assert(
      records
        .filter((r) => !owned.includes(r))
        .every((r) => r.glyphOperations.every((i) => !ownOps.has(i)))
    )
    const ownGlyphs = glyphs.filter((g) => ownOps.has(g.op)),
      ownInk = ownGlyphs
        .map((g) => g.ink)
        .filter(valid)
        .concat(bars.map((b) => b.ink)),
      s = Math.min(MAX_SCALE, MAX_EDGE / Math.max(old[2] - old[0], old[3] - old[1])),
      expand = (r, pixels = 1, scale = s) =>
        r.map((x, i) => x + (i < 2 ? -pixels / scale : pixels / scale)),
      // Em rectangles may overlap a preceding caption's descenders. Preserve
      // complete painted outlines, rather than claiming their empty em space.
      complete = union(ownInk.map((r) => expand(r))),
      offset = complete.map((x, i) =>
        i < 2 ? Math.min(0, Math.floor((x - old[i]) * s)) : Math.max(0, Math.ceil((x - old[i]) * s))
      ),
      nativeCrop = old.map((x, i) => x + offset[i] / s),
      strictInside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i])),
      foreign = [
        ...glyphs.filter((g) => !ownOps.has(g.op)).flatMap((g) => [g.ink, g.advance]),
        ...paths.filter((p) => !ownPaths.has(p.operationIndex)).map((p) => p.ink),
        ...e.images.map((i) => i.rect)
      ],
      separated = (scale) =>
        foreign.every((r) => !valid(r) || !over(nativeCrop, expand(r, 3, scale)))
    assert(
      offset[1] < 0 &&
        strictInside([0, 0, n.viewport.width, n.viewport.height], nativeCrop) &&
        Math.min(
          MAX_SCALE,
          MAX_EDGE / Math.max(nativeCrop[2] - nativeCrop[0], nativeCrop[3] - nativeCrop[1])
        ) === s
    )
    assert(ownInk.every((r) => strictInside(nativeCrop, expand(r))) && separated(s))
    assert(
      n.operators.fnArray.every(
        (op, i) =>
          op !== OPS.setGState ||
          n.operators.argsArray[i][0].every(
            ([key, value]) => !['ca', 'CA'].includes(key) || value === 1
          )
      )
    )
    assert(
      ownGlyphs.every((g) => !valid(g.ink) || strictInside(e.texts.get(g.op).clip, expand(g.ink)))
    )
    assert(bars.every((b) => strictInside(e.paths.get(b.operationIndex).clip, expand(b.ink))))
    assert(
      [
        ...captions.map((c) => c.rect),
        ...competingRects,
        ...otherFigures
          .filter((f) => f.page === table.page && f.region)
          .map((f) => f.region.map((x, i) => x * (i % 2 ? n.viewport.height : n.viewport.width)))
      ].every((r) => valid(r) && !over(nativeCrop, r))
    )
    const proof = {
        cropRect: nativeCrop.map((x) => x * v.scale),
        nativeCrop,
        oldNativeCrop: old,
        regions: [nativeCrop],
        offset,
        rasterScale: s,
        pixelWidth: Math.ceil((nativeCrop[2] - nativeCrop[0]) * s),
        pixelHeight: Math.ceil((nativeCrop[3] - nativeCrop[1]) * s),
        bounds: { width: n.viewport.width, height: n.viewport.height },
        ownInk,
        foreign: []
      },
      inputs = retainNativeRecoveryInputs(
        [
          table,
          rules,
          n,
          sourceContent,
          nativeContent,
          page,
          captions,
          competingRects,
          otherFigures
        ],
        v,
        n.viewport
      ),
      output = retainNativeRecoveryInputs([proof]),
      current = () =>
        inputs?.() &&
        output?.() &&
        witness.current() &&
        context.nativeGlyphContext === n &&
        context.sourceContent === sourceContent &&
        context.viewport === v &&
        options.page === page &&
        options.nativePage === nativePage &&
        options.nativeContent === nativeContent &&
        options.captions === captions &&
        options.competingRects === competingRects &&
        options.otherFigures === otherFigures,
      rasterCurrent = (png) => {
        const p = getPdfCropRasterProtectionFromPng(png, nativeCrop, proof.bounds)
        return (
          p &&
          p.scaleLower > 0 &&
          separated(p.scaleLower) &&
          ownInk.every((r) => strictInside(nativeCrop, expand(r, 1, p.scaleLower)))
        )
      }
    assert(current())
    states.set(proof, { table, current, kind: 'ruled-body', rasterCurrent })
    return proof
  } catch {
    return
  }
}

// A sparse terminal band has no cell-map authority. Four complete native rules
// and a fully accounted source/paint inventory can nevertheless close its crop.
function proveRuledTerminalPixels(table, rules, context, options) {
  try {
    assert(table.issues?.length === 1 && table.issues[0] === 'unassigned-source-text')
    assert(
      table.unassigned?.length > 0 &&
        table.clipped?.length === 0 &&
        !table.parts &&
        !table.cropRects &&
        !table.notes?.length
    )
    const n = context.nativeGlyphContext,
      v = context.viewport,
      { page, nativePage, nativeContent, captions, competingRects, otherFigures } = options,
      sourceContent = context.sourceContent,
      old = table.cropRect.map((x) => x / v.scale),
      caption = table.caption
    assert(
      n &&
        valid(old) &&
        v.scale > 0 &&
        v.rotation === 0 &&
        n.viewport.scale === 1 &&
        n.viewport.rotation === 0
    )
    assert(
      v.width === n.viewport.width * v.scale &&
        v.height === n.viewport.height * v.scale &&
        same(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height])
    )
    assert(
      table.sourceViewport?.scale === v.scale &&
        table.sourceViewport.width === v.width &&
        table.sourceViewport.height === v.height
    )
    assert(
      caption?.page === table.page &&
        valid(caption.rect) &&
        !caption.regions &&
        caption.rect[3] < old[1]
    )
    assert(Array.isArray(captions) && Array.isArray(competingRects) && Array.isArray(otherFigures))
    assert(
      captions.filter(
        (c) =>
          c.page === table.page &&
          same(c.rect, caption.rect) &&
          compact(c.text ?? c.lines.join(' ')) === compact(caption.text)
      ).length === 1
    )
    const tokens = n.content.items
        .filter((r) => r.str?.trim())
        .map((r) => tableTextToken(r, n.viewport, 0)),
      packet = nativePageTextPacketInventory(page, tokens, n, true),
      witness = capture(table, context, options, 'foreign-raster-footer')
    assert(
      packet &&
        witness &&
        packet.records.length <= 4096 &&
        packet.evidence.paths.size <= 4096 &&
        !witness.patternOperations.length
    )
    const records = packet.records,
      byIndex = new Map(records.map((r) => [r.index, r])),
      claims = new Set(),
      slots = new Set()
    for (const cell of table.cells) {
      assert(
        Number.isSafeInteger(cell.row) &&
          cell.row >= 0 &&
          Number.isSafeInteger(cell.column) &&
          cell.column >= 0 &&
          cell.rowSpan === 1 &&
          cell.colSpan === 1 &&
          !cell.sourceSegments?.length
      )
      assert(
        !slots.has(cell.row + ':' + cell.column) &&
          table.grid[cell.row]?.[cell.column] === cell.text
      )
      slots.add(cell.row + ':' + cell.column)
      assert(
        (cell.sourceItems?.length ?? 0) === (cell.sourceRects?.length ?? 0) &&
          (!cell.text?.trim() || cell.sourceItems?.length)
      )
      for (const [i, s] of (cell.sourceItems ?? []).entries()) {
        const r = byIndex.get(s.index)
        assert(
          r &&
            s.pageNumber === table.page &&
            s.text === r.r.str &&
            !claims.has(s.index) &&
            same(tableTextToken(sourceContent.items[s.index], v, 0).rect, cell.sourceRects[i])
        )
        claims.add(s.index)
      }
    }
    assert(claims.size > 0)
    const paths = [...packet.evidence.paths]
        .filter(
          ([i]) => ![OPS.endPath, OPS.clip, OPS.eoClip].includes(n.operators.argsArray[i]?.[0])
        )
        .map(([operationIndex, state]) => {
          const support = nativeFigurePathPaint(packet, operationIndex, state)
          assert(support && valid(support.rect))
          return { operationIndex, state, support }
        }),
      horizontal = []
    for (const q of paths) {
      const a = n.operators.argsArray[q.operationIndex],
        p = a?.[1]?.[0]
      if (a?.[0] !== OPS.stroke || p?.length !== 6 || p[0] !== 0 || p[3] !== 1 || p[2] !== p[5])
        continue
      const exact = ruledPath(n, packet.evidence, q.operationIndex)
      if (exact.ink[0] >= old[0] && exact.ink[2] <= old[2] && exact.ink[1] > old[1])
        horizontal.push({ ...q, ...exact })
    }
    const families = []
    for (const h of horizontal) {
      const group = horizontal
        .filter((q) => Math.abs(q.ink[0] - h.ink[0]) < 1e-6 && Math.abs(q.ink[2] - h.ink[2]) < 1e-6)
        .sort((a, b) => a.ink[1] - b.ink[1])
      if (
        group.length === 4 &&
        group[2].ink[3] < old[3] &&
        group[3].ink[1] > old[3] &&
        !families.some((g) => g[0] === group[0])
      )
        families.push(group)
    }
    assert(families.length === 1)
    const bars = families[0],
      frame = [bars[0].ink[0], bars[0].ink[1], bars[0].ink[2], bars[3].ink[3]],
      body = records.filter((r) => claims.has(r.index)),
      footer = records.filter((r) => !claims.has(r.index) && over(r.rect, frame)),
      footerBand = [frame[0], bars[2].ink[3], frame[2], bars[3].ink[1]]
    // The source advance can overhang a rule by font rounding. Its complete
    // painted outline must be in the frame, and its advance in the old crop.
    assert(
      body.every(
        (r) =>
          inside(old, r.rect) &&
          r.part.every(({ g }) => inside(frame, g.ink) && g.ink[3] < bars[2].ink[1])
      )
    )
    assert(
      body.some((r) => r.rect[3] < bars[1].ink[1]) && body.some((r) => r.rect[1] > bars[1].ink[3])
    )
    assert(
      footer.length === table.unassigned.length &&
        claims.size + footer.length === table.selectedTextItems
    )
    // Diagnostics are corroboration only. Source identity comes from the whole
    // occurrence inventory and its native, closed terminal band.
    assert(same(footer.map((r) => r.r.str).sort(), [...table.unassigned].sort()))
    assert(
      footer.every((r) => inside(footerBand, r.rect) && r.rect[1] < old[3] && r.rect[3] > old[3])
    )
    const owned = [...body, ...footer],
      ownGlyphs = new Set(owned.flatMap((r) => r.part.map((z) => z.g))),
      ownInk = [...ownGlyphs].map((g) => g.ink).concat(bars.map((b) => b.ink)),
      s = Math.min(MAX_SCALE, MAX_EDGE / Math.max(old[2] - old[0], old[3] - old[1])),
      expand = (r, pixels = 1, scale = s) =>
        r.map((x, i) => x + (i < 2 ? -pixels / scale : pixels / scale)),
      bottom = Math.max(...ownInk.map((r) => r[3])) + 1 / s,
      offset = [0, 0, 0, Math.ceil((bottom - old[3]) * s)],
      nativeCrop = [...old.slice(0, 3), old[3] + offset[3] / s],
      strictInside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i])),
      ownPaths = new Set(bars.map((b) => b.operationIndex)),
      foreign = [
        ...packet.glyphs.filter((g) => !ownGlyphs.has(g)).flatMap((g) => [g.ink, g.advance]),
        ...paths.filter((q) => !ownPaths.has(q.operationIndex)).map((q) => q.support.rect),
        ...packet.evidence.images.map((i) => i.rect)
      ],
      separated = (scale) =>
        foreign.every((r) => !valid(r) || !over(nativeCrop, expand(r, 3, scale)))
    assert(
      nativeCrop[3] > old[3] &&
        strictInside([0, 0, n.viewport.width, n.viewport.height], nativeCrop)
    )
    assert(
      Math.min(
        MAX_SCALE,
        MAX_EDGE / Math.max(nativeCrop[2] - nativeCrop[0], nativeCrop[3] - nativeCrop[1])
      ) === s
    )
    assert(
      owned.every((r) => strictInside(nativeCrop, expand(r.rect))) &&
        ownInk.every((r) => strictInside(nativeCrop, expand(r)))
    )
    assert(
      [...ownGlyphs].every(
        (g) =>
          g.textPaint.fillAlpha === 1 &&
          strictInside(packet.evidence.texts.get(g.i).clip, expand(g.ink))
      )
    )
    assert(bars.every((b) => strictInside(b.state.clip, expand(b.ink))) && separated(s))
    assert(
      [
        ...competingRects,
        ...otherFigures
          .filter((f) => f.page === table.page && f.region)
          .map((f) => f.region.map((x, i) => x * (i % 2 ? n.viewport.height : n.viewport.width)))
      ].every((r) => valid(r) && !over(r, nativeCrop))
    )
    const proof = {
        cropRect: nativeCrop.map((x) => x * v.scale),
        nativeCrop,
        oldNativeCrop: old,
        regions: [nativeCrop],
        offset,
        rasterScale: s,
        pixelWidth: Math.ceil((nativeCrop[2] - nativeCrop[0]) * s),
        pixelHeight: Math.ceil((nativeCrop[3] - nativeCrop[1]) * s),
        bounds: { width: n.viewport.width, height: n.viewport.height },
        ownInk,
        foreign: []
      },
      inputCurrent = retainNativeRecoveryInputs(
        [
          table,
          rules,
          n,
          sourceContent,
          nativeContent,
          page,
          captions,
          competingRects,
          otherFigures
        ],
        v,
        n.viewport
      ),
      outputCurrent = retainNativeRecoveryInputs([proof]),
      current = () =>
        inputCurrent?.() &&
        outputCurrent?.() &&
        witness.current() &&
        context.nativeGlyphContext === n &&
        context.sourceContent === sourceContent &&
        context.viewport === v &&
        options.page === page &&
        options.nativePage === nativePage &&
        options.nativeContent === nativeContent &&
        options.captions === captions &&
        options.competingRects === competingRects &&
        options.otherFigures === otherFigures &&
        !!nativePageTextPacketInventory(page, tokens, n, true),
      rasterCurrent = (png) => {
        const p = getPdfCropRasterProtectionFromPng(png, nativeCrop, proof.bounds)
        return (
          p &&
          Number.isFinite(p.scaleLower) &&
          p.scaleLower > 0 &&
          separated(p.scaleLower) &&
          ownInk.every((r) => strictInside(nativeCrop, expand(r, 1, p.scaleLower)))
        )
      }
    assert(current())
    states.set(proof, { table, current, kind: 'ruled-body', rasterCurrent })
    return proof
  } catch {
    return
  }
}

// A complete native ruled body can own a physical preview even when its scalar
// cells remain unreliable. This branch never changes cells or their diagnostics.
function ruledPath(n, evidence, operationIndex, diagonal = false) {
  const a = n.operators.argsArray[operationIndex],
    s = evidence.paths.get(operationIndex)
  assert(s && Array.isArray(a) && a.length === 3)
  const q = Array.from(a[1]?.[0] ?? []),
    m = Util.transform(n.viewport.transform, s.transform),
    points = []
  assert(q.length <= 13 && m[1] === 0 && m[2] === 0 && m[0] > 0 && m[3] === -m[0])
  for (let k = 0; k < q.length;) {
    const op = q[k++]
    if (op === 4) continue
    assert(op === 0 || op === 1)
    const p = [q[k++], q[k++]]
    assert(p.every(Number.isFinite))
    Util.applyTransform(p, m)
    points.push(p)
  }
  assert(points.length === 2 || points.length === 4)
  const box = union(points.map((p) => [...p, ...p]))
  let ink
  if (a[0] === OPS.stroke) {
    assert(points.length === 2 && s.lineCap === 0 && s.solidStroke && s.strokeAlpha === 1)
    const w = (s.lineWidth * m[0]) / 2
    assert(w > 0 && w < 1)
    if (box[1] === box[3]) ink = [box[0], box[1] - w, box[2], box[3] + w]
    else if (box[0] === box[2]) {
      assert(box[0] === box[2])
      ink = [box[0] - w, box[1], box[2] + w, box[3]]
    } else {
      assert(diagonal && q.length === 6 && q[0] === 0 && q[3] === 1)
      const dx = points[1][0] - points[0][0],
        dy = points[1][1] - points[0][1],
        length = Math.hypot(dx, dy),
        px = Math.abs(dy / length) * w,
        py = Math.abs(dx / length) * w
      ink = [box[0] - px, box[1] - py, box[2] + px, box[3] + py]
    }
  } else {
    assert(
      [OPS.fill, OPS.eoFill].includes(a[0]) &&
        points.length === 4 &&
        s.fillAlpha === 1 &&
        q.at(-1) === 4
    )
    assert(
      new Set(points.map((p) => p[0])).size === 2 && new Set(points.map((p) => p[1])).size === 2
    )
    assert(
      points.every((p, i) => p[0] === points[(i + 1) % 4][0] || p[1] === points[(i + 1) % 4][1])
    )
    ink = box
  }
  assert(valid(ink) && inside(s.clip, ink))
  return {
    operationIndex,
    points,
    ink,
    opaqueBackground:
      [OPS.fill, OPS.eoFill].includes(a[0]) && Math.min(ink[2] - ink[0], ink[3] - ink[1]) > 1
  }
}

// A diagonal corner, a continuous stub rail extending into the known body and
// their shared separator establish the physical table. Complete glyph records
// are selected only after that native path topology, never by matching labels.
function proveDiagonalHeaderBody(table, rules, context, options) {
  try {
    const n = context.nativeGlyphContext,
      v = context.viewport,
      scale = v.scale,
      { page, captions, competingRects, otherFigures, nativePage, nativeContent } = options,
      old = table.cropRect?.map((x) => x / scale),
      caption = table.caption
    assert(n && valid(old) && scale > 0 && v.rotation === 0 && !table.parts && !table.cropRects)
    assert(
      n.viewport.scale === 1 &&
        n.viewport.rotation === 0 &&
        page.pageNumber === table.page &&
        v.width === n.viewport.width * scale &&
        v.height === n.viewport.height * scale &&
        same(v.transform, [scale, 0, 0, -scale, 0, v.height]) &&
        table.sourceViewport?.width === v.width &&
        table.sourceViewport.height === v.height &&
        table.sourceViewport.scale === scale
    )
    assert(
      caption?.page === table.page &&
        valid(caption.rect) &&
        caption.rect[3] < old[1] &&
        !caption.regions &&
        Array.isArray(captions) &&
        Array.isArray(competingRects) &&
        Array.isArray(otherFigures)
    )
    assert(captions.filter((c) => c.page === table.page && same(c.rect, caption.rect)).length === 1)
    assert(Array.isArray(table.cells) && table.cells.length <= 4096 && !table.notes?.length)
    assert(table.issues?.includes('text-crosses-crop-boundary'))
    // Avoid a full font witness on ordinary tables. This is only an admission
    // hint; the source-bound path and its transformed endpoints are proved below.
    assert(
      n.operators.fnArray.some((op, i) => {
        const a = n.operators.argsArray[i],
          q = a?.[1]?.[0]
        return (
          op === OPS.constructPath &&
          a[0] === OPS.stroke &&
          q?.length === 6 &&
          q[0] === 0 &&
          q[3] === 1 &&
          q[1] !== q[4] &&
          q[2] !== q[5]
        )
      })
    )
    const witness = capture(table, context, options, 'closed-ruled-body')
    assert(witness && !witness.patternOperations.length && !witness.e.images.length)
    const { records, e } = witness,
      paths = n.graphicsBounds.map((g) => ruledPath(n, e, g.operationIndex, true)),
      lines = paths.filter(
        (p) =>
          p.points.length === 2 &&
          n.operators.argsArray[p.operationIndex][0] === OPS.stroke &&
          n.operators.argsArray[p.operationIndex][1][0].length === 6 &&
          n.operators.argsArray[p.operationIndex][1][0][0] === 0 &&
          n.operators.argsArray[p.operationIndex][1][0][3] === 1
      ),
      vertical = lines.filter((p) => p.points[0][0] === p.points[1][0]),
      horizontal = lines.filter((p) => p.points[0][1] === p.points[1][1]),
      diagonals = lines.filter((p) => !vertical.includes(p) && !horizontal.includes(p))
    assert(diagonals.length === 1)
    const diagonal = diagonals[0],
      [left, right] = [...diagonal.points].sort((a, b) => a[0] - b[0]),
      epsilon = 0.0001,
      touch = (a, b) =>
        a[0] <= b[2] + epsilon &&
        a[2] + epsilon >= b[0] &&
        a[1] <= b[3] + epsilon &&
        a[3] + epsilon >= b[1],
      rails = vertical
        .filter((p) => p.ink[0] <= diagonal.ink[2] && p.ink[2] >= right[0])
        .sort((a, b) => a.ink[1] - b.ink[1])
    assert(left[1] < right[1] && rails.length && rails.length <= 256)
    const rail = union(rails.map((p) => p.ink)),
      axis = rails[0].points[0][0]
    assert(
      rails.every((p) => Math.abs(p.points[0][0] - axis) < epsilon) &&
        rails.some((p) => touch(p.ink, diagonal.ink))
    )
    for (let i = 1; i < rails.length; i++)
      assert(
        touch(rails[i - 1].ink, rails[i].ink) ||
          horizontal.some((p) => touch(p.ink, rails[i - 1].ink) && touch(p.ink, rails[i].ink))
      )
    const separators = horizontal.filter((p) => {
      const ends = [...p.points].sort((a, b) => a[0] - b[0])
      return (
        Math.abs(ends[0][0] - left[0]) < epsilon &&
        ends[1][0] > rail[2] &&
        ends[0][1] > right[1] &&
        ends[0][1] < rail[3] &&
        touch(p.ink, rail)
      )
    })
    assert(separators.length === 1)
    const separator = separators[0],
      ends = [...separator.points].sort((a, b) => a[0] - b[0]),
      frame = [left[0], rail[1], ends[1][0], rail[3]],
      divider = ends[0][1]
    assert(
      valid(frame) &&
        caption.rect[3] < frame[1] &&
        frame[1] < left[1] &&
        right[1] < old[1] &&
        old[1] < divider + (separator.ink[3] - separator.ink[1]) &&
        old[3] > divider &&
        old[0] < axis &&
        old[2] > axis
    )
    const own = records.filter((r) => inside(frame, r.ink)),
      ownIds = new Set(own.map((r) => r.index)),
      claims = new Set()
    assert(own.length >= 4 && own.every((r) => r.horizontalComplete))
    for (const cell of table.cells) {
      if (!cell.text.trim()) {
        assert(!cell.sourceItems?.length && !cell.sourceRects?.length)
        continue
      }
      assert(cell.sourceItems?.length && cell.sourceItems.length === cell.sourceRects?.length)
      for (const [i, source] of cell.sourceItems.entries()) {
        const r = records.find((r) => r.index === source.index)
        assert(
          r &&
            ownIds.has(r.index) &&
            source.pageNumber === table.page &&
            source.text === r.text &&
            !claims.has(r.index) &&
            r.sourceRect.every((x, j) => Math.abs(x * scale - cell.sourceRects[i][j]) < 1e-6)
        )
        claims.add(r.index)
      }
    }
    assert(
      claims.size >= 4 && claims.size + (table.unassigned?.length ?? 0) === table.selectedTextItems
    )
    const body = own.filter((r) => claims.has(r.index) && r.ink[1] > divider)
    assert(
      body.some((r) => r.ink[2] < axis) &&
        body.some((r) => r.ink[0] > axis) &&
        own.some((r) => r.ink[3] < divider && !claims.has(r.index))
    )
    // Native stroke extents may straddle the defining rail by half its width.
    // Every other path remains a foreign occurrence; nothing is dropped.
    const edge = Math.max(...lines.map((p) => e.paths.get(p.operationIndex).lineWidth)) + epsilon,
      pathFrame = frame.map((x, i) => x + (i < 2 ? -edge : edge)),
      ownPaths = paths.filter((p) => inside(pathFrame, p.ink)),
      foreignPaths = paths.filter((p) => !ownPaths.includes(p))
    assert(
      ownPaths.includes(diagonal) &&
        ownPaths.includes(separator) &&
        rails.every((p) => ownPaths.includes(p))
    )
    const s = Math.min(MAX_SCALE, MAX_EDGE / Math.max(old[2] - old[0], old[3] - old[1])),
      aa = 1 / s,
      expand = (r) => r.map((x, i) => x + (i < 2 ? -aa : aa)),
      ownInk = [...own.map((r) => r.ink), ...ownPaths.map((p) => p.ink)],
      mask = expand(union(ownInk)),
      envelope = expand(union([...ownInk, ...own.flatMap((r) => [r.advance, r.sourceRect])])),
      offset = envelope.map((x, i) => (i < 2 ? Math.floor : Math.ceil)((x - old[i]) * s)),
      nativeCrop = old.map((x, i) => x + offset[i] / s),
      foreign = [
        ...records.filter((r) => !ownIds.has(r.index)).map((r) => r.ink),
        ...foreignPaths.map((p) => p.ink)
      ]
    assert(
      valid(nativeCrop) &&
        inside(nativeCrop, mask) &&
        inside([0, 0, n.viewport.width, n.viewport.height], nativeCrop) &&
        Math.min(
          MAX_SCALE,
          MAX_EDGE / Math.max(nativeCrop[2] - nativeCrop[0], nativeCrop[3] - nativeCrop[1])
        ) === s &&
        nativeCrop[1] < old[1] &&
        nativeCrop[1] > caption.rect[3]
    )
    assert(
      own.every(
        (r) => inside(nativeCrop, expand(r.advance)) && inside(nativeCrop, expand(r.sourceRect))
      ) &&
        foreign.every((r) => !over(expand(r), mask)) &&
        ownPaths.every((p) => inside(e.paths.get(p.operationIndex).clip, expand(p.ink)))
    )
    for (const r of own)
      for (const op of r.glyphOperations)
        assert(e.texts.get(op) && inside(e.texts.get(op).clip, expand(r.ink)))
    assert(
      [
        ...competingRects,
        ...otherFigures
          .filter((f) => f.page === table.page && f.region)
          .map((f) => f.region.map((x, i) => x * (i % 2 ? n.viewport.height : n.viewport.width)))
      ].every((r) => valid(r) && !over(r, nativeCrop))
    )
    const proof = {
      cropRect: nativeCrop.map((x) => x * scale),
      nativeCrop,
      oldNativeCrop: old,
      regions: [mask],
      offset,
      rasterScale: s,
      pixelWidth: Math.ceil((nativeCrop[2] - nativeCrop[0]) * s),
      pixelHeight: Math.ceil((nativeCrop[3] - nativeCrop[1]) * s),
      bounds: { width: n.viewport.width, height: n.viewport.height },
      ownInk,
      foreign
    }
    const retained = retainNativeRecoveryInputs(
      [
        table,
        rules,
        n,
        context.operators,
        context.sourceContent,
        page,
        captions,
        competingRects,
        otherFigures,
        nativeContent,
        proof,
        v
      ],
      v,
      n.viewport
    )
    assert(retained)
    const current = () =>
      witness.current() &&
      retained() &&
      options.captions === captions &&
      options.competingRects === competingRects &&
      options.otherFigures === otherFigures &&
      options.page === page &&
      options.nativePage === nativePage &&
      options.nativeContent === nativeContent
    assert(current())
    states.set(proof, { table, current, kind: 'ruled-body' })
    return proof
  } catch {
    return
  }
}
function proveRuledBody(table, rules, context, options) {
  try {
    const { captions, competingRects, otherFigures } = options,
      n = context.nativeGlyphContext,
      scale = context.viewport.scale,
      old = table.cropRect?.map((x) => x / scale)
    assert(n && valid(old) && !table.parts && !table.cropRects && Array.isArray(table.issues))
    // Scalar completeness does not prove that the model crop contains its rails.
    // Keep the same physical proof when a separate repair completes the grid.
    assert(
      table.caption?.page === table.page && valid(table.caption.rect) && !table.caption.regions
    )
    assert(
      table.caption.rect[3] < old[1] && /^Table\s+(?:[A-Z]?\d+)[.:]\s/u.test(table.caption.text)
    )
    assert(
      table.sourceViewport?.scale === scale &&
        table.sourceViewport.width === context.viewport.width &&
        table.sourceViewport.height === context.viewport.height
    )
    assert(Array.isArray(captions) && Array.isArray(competingRects) && Array.isArray(otherFigures))
    assert(
      captions.filter(
        (c) =>
          c.page === table.page &&
          same(c.rect, table.caption.rect) &&
          compact(c.text ?? c.lines.join(' ')) === compact(table.caption.text)
      ).length === 1
    )
    // Explicit opaque defaults have the same paint semantics as omitted state.
    // Other compositing changes still decline this optional physical frame.
    assert(
      n.operators.fnArray.every(
        (op, i) =>
          op !== OPS.setGState ||
          n.operators.argsArray[i][0].every(
            ([key, value]) =>
              (key === 'BM' && value === 'source-over') ||
              (['ca', 'CA'].includes(key) && value === 1)
          )
      )
    )
    const witness = capture(table, context, options, 'closed-ruled-body')
    assert(witness && witness.patternOperations.length === 0 && witness.e.images.length === 0)
    const { records, e } = witness,
      title = captionRecords(table.caption, records)
    assert(title?.length)
    const em = Math.max(...title.map((r) => r.advance[3] - r.advance[1])),
      width = old[2] - old[0]
    const paths = n.graphicsBounds.map((g) => {
      assert(g.kind === 'path')
      return ruledPath(n, e, g.operationIndex)
    })
    // Filled rails can have small native rectangular end caps omitted from the
    // line inventory. Include their proved paint before joining; otherwise a
    // complete opening rail can be misclassified as foreign and masked away.
    const paintedRails = paths
      .filter((p) => p.points.length === 4 && p.ink[3] - p.ink[1] <= 1)
      .map(({ ink: r }) => [r[0], (r[1] + r[3]) / 2, r[2], (r[1] + r[3]) / 2])
    const bands = joinHorizontalTableRules(
      [...rules.map((r) => r.map((x) => x / scale)), ...paintedRails],
      0.75
    ).filter(
      (r) =>
        r[2] - r[0] >= width * 0.8 &&
        r[2] - r[0] <= width * 1.2 &&
        r[1] > table.caption.rect[3] &&
        r[1] <= old[3] + em * 2
    )
    const families = []
    for (const r of bands) {
      const group = families.find(
        (g) => Math.abs(g[0][0] - r[0]) <= 1 && Math.abs(g[0][2] - r[2]) <= 1
      )
      if (group) group.push(r)
      else families.push([r])
    }
    const candidates = []
    for (const family of families) {
      family.sort((a, b) => a[1] - b[1])
      if (family.length < 3 || family.length > 64) continue
      const first = family[0],
        last = family.at(-1)
      if (
        first[1] - table.caption.rect[3] > em * 2 ||
        Math.abs(first[1] - old[1]) > em * 2 ||
        Math.abs(last[1] - old[3]) > em * 2
      )
        continue
      const frame = [
          Math.min(...family.map((r) => r[0])),
          first[1],
          Math.max(...family.map((r) => r[2])),
          last[1]
        ],
        loosen = (r) => [r[0] - 1, r[1] - 1, r[2] + 1, r[3] + 1]
      const owned = records.filter(
        (r) =>
          r.sourceRect[0] >= frame[0] - 1 &&
          r.sourceRect[2] <= frame[2] + 1 &&
          r.sourceRect[1] >= table.caption.rect[3] &&
          r.sourceRect[3] <= frame[3] + 0.5
      )
      if (owned.length < 10 || owned.length > 4096 || owned.some((r) => !r.horizontalComplete))
        continue
      const early = owned
        .filter((r) => r.ink[1] < first[1])
        .sort((a, b) => a.sourceRect[0] - b.sourceRect[0])
      if (early.length) {
        if (
          early.length < 2 ||
          early.length > 32 ||
          early.some(
            (r, i) =>
              r.text !== `(${i + 1})` ||
              Math.abs(r.advance[1] - early[0].advance[1]) > 0.02 ||
              Math.abs(r.advance[3] - r.advance[1] - (early[0].advance[3] - early[0].advance[1])) >
                0.02 ||
              r.sourceRect[2] >= early[i + 1]?.sourceRect[0]
          )
        )
          continue
        const fonts = early.map((r) => n.content.items[r.index].fontName)
        if (fonts.some((f) => f !== fonts[0])) continue
      }
      const ownSet = new Set(owned.map((r) => r.index)),
        claims = new Set(),
        outside = []
      for (const cell of table.cells) {
        if (!cell.text.trim()) {
          assert(!cell.sourceItems?.length && !cell.sourceRects?.length)
          continue
        }
        assert(
          Array.isArray(cell.sourceRects) && cell.sourceRects.length === cell.sourceItems?.length
        )
        for (const [i, s] of cell.sourceItems.entries()) {
          const r = records.find((r) => r.index === s.index)
          assert(
            r &&
              r.horizontalComplete &&
              s.pageNumber === table.page &&
              s.text === r.text &&
              !claims.has(s.index)
          )
          assert(
            r.sourceRect
              .map((x) => x * scale)
              .every((x, j) => Math.abs(x - cell.sourceRects[i][j]) < 1e-6)
          )
          claims.add(s.index)
          if (!ownSet.has(s.index)) outside.push(r)
        }
      }
      if (
        claims.size < 10 ||
        claims.size + (table.unassigned?.length ?? 0) !== table.selectedTextItems ||
        owned.filter((r) => claims.has(r.index)).length < claims.size * 0.8
      )
        continue
      if (
        outside.length &&
        (!table.issues.includes('unassigned-source-text') ||
          !table.unassigned?.length ||
          outside.some((r) => r.ink[1] <= last[1]))
      )
        continue
      const ownPaths = paths.filter((p) => inside(loosen(frame), p.ink)),
        foreignPaths = paths.filter((p) => !ownPaths.includes(p))
      if (
        ownPaths.length < 3 ||
        family.some(
          (r) =>
            !ownPaths.some(
              (p) =>
                p.ink[0] <= r[0] + 1 &&
                p.ink[2] >= r[2] - 1 &&
                Math.abs((p.ink[1] + p.ink[3]) / 2 - r[1]) < 0.6
            ) && !ownPaths.filter((p) => p.ink[1] <= r[1] && p.ink[3] >= r[1]).length
        )
      )
        continue
      const s = Math.min(MAX_SCALE, MAX_EDGE / Math.max(old[2] - old[0], old[3] - old[1])),
        aa = 1 / s,
        expand = (r) => r.map((x, i) => x + (i < 2 ? -aa : aa)),
        ownInk = [...owned.map((r) => r.ink), ...ownPaths.map((p) => p.ink)],
        mask = expand(union(ownInk)),
        envelope = expand(union([...ownInk, ...owned.flatMap((r) => [r.advance, r.sourceRect])])),
        offset = envelope.map((x, i) => (i < 2 ? Math.floor : Math.ceil)((x - old[i]) * s)),
        nativeCrop = old.map((x, i) => x + offset[i] / s)
      if (
        !valid(mask) ||
        !valid(nativeCrop) ||
        !inside(nativeCrop, mask) ||
        !inside([0, 0, n.viewport.width, n.viewport.height], nativeCrop) ||
        Math.min(
          MAX_SCALE,
          MAX_EDGE / Math.max(nativeCrop[2] - nativeCrop[0], nativeCrop[3] - nativeCrop[1])
        ) !== s
      )
        continue
      const foreign = [
        ...records.filter((r) => !ownSet.has(r.index)).map((r) => r.ink),
        ...foreignPaths.map((p) => p.ink)
      ]
      if (
        owned.some(
          (r) => !inside(nativeCrop, expand(r.advance)) || !inside(nativeCrop, expand(r.sourceRect))
        ) ||
        ownInk.some((r) => !inside(mask, expand(r))) ||
        ownPaths.some(
          (p) => !p.opaqueBackground && !inside(e.paths.get(p.operationIndex).clip, expand(p.ink))
        ) ||
        foreign.some((r) => over(expand(r), mask))
      )
        continue
      if (
        [
          ...competingRects,
          ...otherFigures
            .filter((f) => f.page === table.page && f.region)
            .map((f) => f.region.map((x, i) => x * (i % 2 ? n.viewport.height : n.viewport.width)))
        ].some((r) => !valid(r) || over(r, nativeCrop))
      )
        continue
      const bodyOps = new Set(owned.flatMap((r) => r.glyphOperations))
      if (
        [...bodyOps].some(
          (i) =>
            !e.texts.get(i) ||
            !inside(
              e.texts.get(i).clip,
              // The original text clip remains active during both renders. Its
              // AA fringe need not be enlarged; actual glyph ink must fit, and
              // renderRuledBody verifies the retained pixels before publication.
              union(owned.filter((r) => r.glyphOperations.includes(i)).map((r) => r.ink))
            )
        )
      )
        continue
      if (!ownInk.some((r) => !inside(old, expand(r))) && !foreign.some((r) => over(r, old)))
        continue
      const proof = {
        cropRect: nativeCrop.map((x) => x * scale),
        nativeCrop,
        oldNativeCrop: old,
        regions: [mask],
        offset,
        rasterScale: s,
        pixelWidth: Math.ceil((nativeCrop[2] - nativeCrop[0]) * s),
        pixelHeight: Math.ceil((nativeCrop[3] - nativeCrop[1]) * s),
        bounds: { width: n.viewport.width, height: n.viewport.height },
        ownInk,
        foreign
      }
      const refs = [
          rules,
          captions,
          competingRects,
          otherFigures,
          ...rules,
          ...captions,
          ...otherFigures
        ],
        value = JSON.stringify({ rules, captions, competingRects, otherFigures, proof }),
        current = () =>
          witness.current() &&
          JSON.stringify({ rules, captions, competingRects, otherFigures, proof }) === value &&
          [options.captions, options.competingRects, options.otherFigures].every(
            (x, i) => x === [captions, competingRects, otherFigures][i]
          ) &&
          [
            rules,
            captions,
            competingRects,
            otherFigures,
            ...rules,
            ...captions,
            ...otherFigures
          ].every((x, i) => x === refs[i])
      candidates.push({ proof, state: { table, current, kind: 'ruled-body' } })
    }
    if (candidates.length !== 1) return
    states.set(candidates[0].proof, candidates[0].state)
    return candidates[0].proof
  } catch {
    return
  }
}
async function renderRuledBody(proof, renderCrop) {
  try {
    const state = states.get(proof)
    if (
      !['ruled-body', 'single-closing-body', 'rail-peer-body'].includes(state?.kind) ||
      !state.current()
    )
      return
    const oldPng = await renderCrop(proof.oldNativeCrop)
    if (!state.current()) return
    const oldBytes = Uint8Array.from(oldPng),
      fullPng = await renderCrop(proof.nativeCrop, proof.regions)
    if (
      !state.current() ||
      oldPng.length !== oldBytes.length ||
      !oldPng.every((x, i) => x === oldBytes[i])
    )
      return
    const fullBytes = Uint8Array.from(fullPng),
      imagesCurrent = () =>
        oldPng.length === oldBytes.length &&
        fullPng.length === fullBytes.length &&
        oldPng.every((x, i) => x === oldBytes[i]) &&
        fullPng.every((x, i) => x === fullBytes[i])
    const a = await loadImage(oldPng)
    if (!state.current() || !imagesCurrent()) return
    const b = await loadImage(fullPng)
    if (!state.current() || !imagesCurrent()) return
    const s = proof.rasterScale,
      [left, top, right, bottom] = proof.offset,
      old = proof.oldNativeCrop,
      next = proof.nativeCrop,
      mask = proof.regions[0]
    assert(
      a.width === Math.ceil((old[2] - old[0]) * s) &&
        a.height === Math.ceil((old[3] - old[1]) * s) &&
        b.width === proof.pixelWidth &&
        b.height === proof.pixelHeight &&
        a.width - left + right === b.width &&
        a.height - top + bottom === b.height
    )
    const canvas = createCanvas(b.width, b.height),
      ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(b, 0, 0)
    ctx.save()
    ctx.beginPath()
    ctx.rect(
      (mask[0] - next[0]) * s,
      (mask[1] - next[1]) * s,
      (mask[2] - mask[0]) * s,
      (mask[3] - mask[1]) * s
    )
    ctx.clip()
    ctx.drawImage(a, -left, -top)
    ctx.restore()
    const data = (im) => {
        const c = createCanvas(im.width, im.height),
          cx = c.getContext('2d')
        cx.drawImage(im, 0, 0)
        const d = cx.getImageData(0, 0, im.width, im.height).data
        c.width = c.height = 1
        return d
      },
      aa = data(a),
      bb = ctx.getImageData(0, 0, b.width, b.height).data,
      white = (d, p) => [0, 1, 2, 3].every((k) => d[p * 4 + k] === 255),
      expand = (r) => r.map((x, i) => x + (i < 2 ? -1 / s : 1 / s))
    let removedForeign = 0,
      restoredOwned = 0
    for (let y = 0; y < a.height; y++)
      for (let x = 0; x < a.width; x++) {
        const p = y * a.width + x,
          nx = x - left,
          ny = y - top,
          q = ny * b.width + nx,
          inNew = nx >= 0 && ny >= 0 && nx < b.width && ny < b.height
        if (inNew && [0, 1, 2, 3].every((k) => aa[p * 4 + k] === bb[q * 4 + k])) continue
        if (white(aa, p)) continue
        const cell = [old[0] + x / s, old[1] + y / s, old[0] + (x + 1) / s, old[1] + (y + 1) / s]
        assert(proof.foreign.some((r) => over(expand(r), cell)))
        removedForeign++
      }
    for (let y = 0; y < b.height; y++)
      for (let x = 0; x < b.width; x++) {
        const p = y * b.width + x,
          ox = x + left,
          oy = y + top
        if (ox >= 0 && oy >= 0 && ox < a.width && oy < a.height) continue
        if (white(bb, p)) continue
        const cell = [
          next[0] + x / s,
          next[1] + y / s,
          next[0] + (x + 1) / s,
          next[1] + (y + 1) / s
        ]
        assert(proof.ownInk.some((r) => over(expand(r), cell)))
        restoredOwned++
      }
    if (removedForeign === 0 && restoredOwned === 0) {
      canvas.width = canvas.height = 1
      return
    }
    const png = canvas.toBuffer('image/png')
    canvas.width = canvas.height = 1
    assert(getPdfCropRasterProtectionFromPng(png, proof.nativeCrop, proof.bounds))
    if (state.rasterCurrent && !state.rasterCurrent(png)) return
    if (!state.current() || !imagesCurrent()) return
    state.png = png
    state.pngBytes = Uint8Array.from(png)
    return png
  } catch {
    return
  }
}

// This optional pixel purpose keeps the complete em/advance envelope. Only
// actual owned ink is copied; no Source, cell, or whole-crop witness is issued.
function proveSingleClosingBody(table, rules, context, options) {
  try {
    const n = context.nativeGlyphContext,
      v = context.viewport,
      sourceContent = context.sourceContent,
      nativeContent = options.nativeContent,
      { page, captions, competingRects, otherFigures } = options,
      old = table.cropRect?.map((x) => x / v.scale),
      strictInside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i])),
      literal = (s) => s.replace(/\s/gu, '')
    assert(n && valid(old) && v.scale > 0 && v.rotation === 0)
    assert(
      n.viewport.scale === 1 &&
        n.viewport.rotation === 0 &&
        v.width === n.viewport.width * v.scale &&
        v.height === n.viewport.height * v.scale &&
        same(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) &&
        table.sourceViewport?.scale === v.scale &&
        table.sourceViewport.width === v.width &&
        table.sourceViewport.height === v.height &&
        page.pageNumber === table.page
    )
    assert(
      !table.parts &&
        !table.cropRects &&
        !table.notes?.length &&
        Array.isArray(table.issues) &&
        table.issues.length === 0 &&
        table.clipped?.length === 0 &&
        table.unassigned?.length === 0 &&
        Array.isArray(table.grid) &&
        table.grid.length >= 3 &&
        Array.isArray(table.cells)
    )
    assert(Array.isArray(captions) && Array.isArray(competingRects) && Array.isArray(otherFigures))
    const caption = table.caption
    assert(
      caption?.page === table.page &&
        valid(caption.rect) &&
        !caption.regions &&
        Array.isArray(caption.lines) &&
        caption.lines.length >= 2 &&
        /^Table\s+[A-Z]?\d+[.:]\s/u.test(caption.text) &&
        caption.rect[3] < old[1]
    )
    assert(
      captions.filter(
        (c) =>
          c.page === table.page &&
          same(c.rect, caption.rect) &&
          literal(c.text ?? c.lines.join(' ')) === literal(caption.text)
      ).length === 1
    )
    const tokens = n.content.items
        .filter((r) => r.str.trim())
        .map((r) => tableTextToken(r, n.viewport, 0)),
      p = nativePageTextPacketInventory(page, tokens, n)
    assert(
      p &&
        p.records.length <= 4096 &&
        p.glyphs.length <= 100000 &&
        p.evidence.images.length === 0 &&
        p.evidence.paths.size <= 4096
    )
    return singleClosingBodyProof(
      table,
      rules,
      context,
      options,
      p,
      tokens,
      () => !!nativePageTextPacketInventory(page, tokens, n),
      {
        n,
        v,
        sourceContent,
        nativeContent,
        page,
        captions,
        competingRects,
        otherFigures,
        old,
        strictInside,
        caption
      }
    )
  } catch {
    return
  }
}

function proveUnreliableSingleClosingBody(table, rules, context, options) {
  try {
    const n = context.nativeGlyphContext,
      v = context.viewport,
      sourceContent = context.sourceContent,
      nativeContent = options.nativeContent,
      { page, captions, competingRects, otherFigures } = options,
      old = table.cropRect?.map((x) => x / v.scale),
      strictInside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i])),
      literal = (s) => s.replace(/\s/gu, '')
    assert(n && valid(old) && v.scale > 0 && v.rotation === 0)
    assert(
      n.viewport.scale === 1 &&
        n.viewport.rotation === 0 &&
        v.width === n.viewport.width * v.scale &&
        v.height === n.viewport.height * v.scale &&
        same(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) &&
        table.sourceViewport?.scale === v.scale &&
        table.sourceViewport.width === v.width &&
        table.sourceViewport.height === v.height &&
        page.pageNumber === table.page
    )
    assert(
      !table.parts &&
        !table.cropRects &&
        !table.notes?.length &&
        Array.isArray(table.issues) &&
        table.issues.length === 1 &&
        table.issues[0] === 'overlapping-predicted-columns' &&
        table.clipped?.length === 0 &&
        table.unassigned?.length === 0 &&
        Array.isArray(table.grid) &&
        table.grid.length >= 3 &&
        Array.isArray(table.cells)
    )
    assert(Array.isArray(captions) && Array.isArray(competingRects) && Array.isArray(otherFigures))
    const caption = table.caption
    assert(
      caption?.page === table.page &&
        valid(caption.rect) &&
        !caption.regions &&
        Array.isArray(caption.lines) &&
        caption.lines.length >= 2 &&
        /^Table\s+[A-Z]?\d+[.:]\s/u.test(caption.text) &&
        caption.rect[3] < old[1]
    )
    assert(
      captions.filter(
        (c) =>
          c.page === table.page &&
          same(c.rect, caption.rect) &&
          literal(c.text ?? c.lines.join(' ')) === literal(caption.text)
      ).length === 1
    )
    const tokens = n.content.items
        .filter((r) => r.str.trim())
        .map((r) => tableTextToken(r, n.viewport, 0)),
      handle = createNativeSingleClosingTablePixelEvidence(page, tokens, n, table),
      p = nativeSingleClosingTablePixelEvidenceData(handle, page, tokens, n, table)
    assert(
      p &&
        p.records.length <= 4096 &&
        p.glyphs.length <= 100000 &&
        p.evidence.images.length === 0 &&
        p.evidence.paths.size <= 4096
    )
    return singleClosingBodyProof(
      table,
      rules,
      context,
      options,
      p,
      tokens,
      () => !!nativeSingleClosingTablePixelEvidenceData(handle, page, tokens, n, table),
      {
        n,
        v,
        sourceContent,
        nativeContent,
        page,
        captions,
        competingRects,
        otherFigures,
        old,
        strictInside,
        caption
      }
    )
  } catch {
    return
  }
}

function singleClosingBodyProof(table, rules, context, options, p, tokens, evidenceCurrent, bound) {
  try {
    const {
      n,
      v,
      sourceContent,
      nativeContent,
      page,
      captions,
      competingRects,
      otherFigures,
      old,
      strictInside,
      caption
    } = bound
    const records = new Map(p.records.map((r) => [r.index, r])),
      claims = new Set(),
      owned = []
    for (const cell of table.cells) {
      if (!cell.text.trim()) {
        assert(!cell.sourceItems?.length && !cell.sourceRects?.length)
        continue
      }
      assert(cell.sourceItems?.length && cell.sourceRects?.length === cell.sourceItems.length)
      for (const [i, source] of cell.sourceItems.entries()) {
        const r = records.get(source.index)
        assert(
          r &&
            source.pageNumber === table.page &&
            source.text === r.r.str &&
            !claims.has(source.index) &&
            r.r.sourceItem?.pageNumber === table.page &&
            r.r.sourceItem.index === source.index &&
            r.r.sourceItem.text === source.text &&
            same(tableTextToken(sourceContent.items[source.index], v, 0).rect, cell.sourceRects[i])
        )
        assert(
          r.part.length &&
            r.part.every(
              ({ g }) =>
                valid(g.ink) && valid(g.advance) && g.textPaint.fillAlpha === 1 && g.height > 0
            )
        )
        claims.add(source.index)
        owned.push(r)
      }
    }
    assert(claims.size >= 10 && claims.size === table.selectedTextItems)
    const title = p.records.filter((r) => over(r.rect, caption.rect))
    assert(
      title.length &&
        title.every((r) => !claims.has(r.index)) &&
        title[0].r.str.match(/^Table\s+[A-Z]?\d+[.:](?=\s|$)/u)?.[0] ===
          caption.text.match(/^Table\s+[A-Z]?\d+[.:]/u)?.[0]
    )
    assert(union(title.map((r) => r.rect)).every((x, i) => Math.abs(x - caption.rect[i]) < 1e-6))
    const ownGlyphs = new Set(owned.flatMap((r) => r.part.map((z) => z.g))),
      glyphInk = [...ownGlyphs].map((g) => g.ink),
      glyphBox = union(glyphInk),
      heights = owned.map((r) => r.r.height).sort((a, b) => a - b),
      em = heights[heights.length >> 1],
      paths = [...p.evidence.paths].map(([operationIndex, state]) => {
        const support = nativeFigurePathPaint(p, operationIndex, state)
        assert(support && valid(support.rect))
        return { operationIndex, state, support }
      }),
      closings = []
    for (const q of paths) {
      const a = p.o.argsArray[q.operationIndex],
        path = Array.from(a?.[1]?.[0] ?? [])
      const m = Util.transform(p.v.transform, q.state.transform)
      if (
        a[0] !== OPS.stroke ||
        path.length !== 6 ||
        path[0] !== 0 ||
        path[3] !== 1 ||
        !path.every(Number.isFinite) ||
        path[2] !== path[5] ||
        path[1] === path[4] ||
        q.state.lineCap !== 0 ||
        !q.state.solidStroke ||
        q.state.strokeAlpha !== 1 ||
        m[1] !== 0 ||
        m[2] !== 0 ||
        m[0] <= 0 ||
        m[3] !== -m[0] ||
        !((q.state.lineWidth * m[0]) / 2 > 0 && (q.state.lineWidth * m[0]) / 2 < 1)
      )
        continue
      const exact = ruledPath(n, p.evidence, q.operationIndex)
      if (
        exact.ink[0] <= glyphBox[0] &&
        exact.ink[2] >= glyphBox[2] &&
        exact.ink[1] > glyphBox[3] &&
        exact.ink[1] - glyphBox[3] < em
      )
        closings.push({ ...q, ink: exact.ink })
    }
    assert(closings.length === 1)
    const closing = closings[0],
      s = Math.min(MAX_SCALE, MAX_EDGE / Math.max(old[2] - old[0], old[3] - old[1])),
      expand = (r, pixels = 1, scale = s) =>
        r.map((x, i) => x + (i < 2 ? -pixels / scale : pixels / scale)),
      ownInk = [...glyphInk, closing.ink],
      full = [...owned.map((r) => r.rect), ...[...ownGlyphs].map((g) => g.advance)],
      mask = expand(union(ownInk)),
      envelope = expand(union([...ownInk, ...full])),
      offset = envelope.map((x, i) => (i < 2 ? Math.floor : Math.ceil)((x - old[i]) * s)),
      nativeCrop = old.map((x, i) => x + offset[i] / s)
    assert(
      valid(mask) &&
        valid(nativeCrop) &&
        strictInside(nativeCrop, mask) &&
        strictInside([0, 0, n.viewport.width, n.viewport.height], nativeCrop) &&
        Math.min(
          MAX_SCALE,
          MAX_EDGE / Math.max(nativeCrop[2] - nativeCrop[0], nativeCrop[3] - nativeCrop[1])
        ) === s
    )
    const foreignGlyphs = p.glyphs.filter((g) => !ownGlyphs.has(g)),
      foreignPaths = paths.filter((q) => q.operationIndex !== closing.operationIndex),
      foreignSources = n.content.items.flatMap((r, index) => {
        assert(
          typeof r.str === 'string' &&
            r.sourceItem?.pageNumber === table.page &&
            r.sourceItem.index === index &&
            r.sourceItem.text === r.str
        )
        const rect = tableTextToken(r, n.viewport, 0).rect
        assert(rect.every(Number.isFinite) && rect[0] <= rect[2] && rect[1] <= rect[3])
        return claims.has(index) ? [] : [rect]
      }),
      foreignDomains = [
        ...foreignSources,
        ...foreignGlyphs.flatMap((g) => [g.ink, g.advance]),
        ...foreignPaths.map((q) => q.support.rect)
      ],
      titleGlyphs = new Set(title.flatMap((r) => r.part.map(({ g }) => g))),
      foreign = foreignGlyphs.filter((g) => titleGlyphs.has(g)).map((g) => g.ink),
      // A non-owned page object is not automatically removable table content.
      // Only the already closed caption may leave old pixels in this purpose.
      deletionCurrent = (scale) =>
        foreignPaths.every((q) =>
          [old, nativeCrop].every((crop) => !over(expand(q.support.rect, 3, scale), crop))
        ) &&
        foreignGlyphs.every(
          (g) =>
            titleGlyphs.has(g) ||
            [g.ink, g.advance].every(
              (rect) =>
                !valid(rect) ||
                [old, nativeCrop].every((crop) => !over(expand(rect, 3, scale), crop))
            )
        )
    assert(
      full.every((r) => strictInside(nativeCrop, expand(r))) &&
        ownInk.every((r) => strictInside(mask, expand(r))) &&
        [...ownGlyphs].every(
          (g) =>
            p.evidence.texts.get(g.i)?.clip &&
            strictInside(p.evidence.texts.get(g.i).clip, expand(g.ink))
        ) &&
        strictInside(closing.state.clip, expand(closing.ink)) &&
        foreignDomains.every((r) => !valid(r) || !over(mask, expand(r, 3)))
    )
    assert(
      [
        ...competingRects,
        ...otherFigures
          .filter((f) => f.page === table.page && f.region)
          .map((f) => f.region.map((x, i) => x * (i % 2 ? n.viewport.height : n.viewport.width)))
      ].every((r) => valid(r) && !over(r, nativeCrop))
    )
    assert(deletionCurrent(s) && foreign.some((r) => over(r, old)))
    const proof = {
        cropRect: nativeCrop.map((x) => x * v.scale),
        nativeCrop,
        oldNativeCrop: old,
        regions: [mask],
        offset,
        rasterScale: s,
        pixelWidth: Math.ceil((nativeCrop[2] - nativeCrop[0]) * s),
        pixelHeight: Math.ceil((nativeCrop[3] - nativeCrop[1]) * s),
        bounds: { width: n.viewport.width, height: n.viewport.height },
        ownInk,
        foreign
      },
      inputCurrent = retainNativeRecoveryInputs(
        [
          table,
          rules,
          n,
          sourceContent,
          page,
          captions,
          competingRects,
          otherFigures,
          nativeContent
        ],
        v,
        n.viewport
      ),
      outputCurrent = retainNativeRecoveryInputs([proof]),
      current = () =>
        inputCurrent?.() &&
        outputCurrent?.() &&
        context.nativeGlyphContext === n &&
        context.viewport === v &&
        context.sourceContent === sourceContent &&
        options.nativeContent === nativeContent &&
        options.page === page &&
        options.captions === captions &&
        options.competingRects === competingRects &&
        options.otherFigures === otherFigures &&
        !!evidenceCurrent(),
      rasterCurrent = (png) => {
        const protection = getPdfCropRasterProtectionFromPng(png, nativeCrop, proof.bounds)
        if (!protection) return false
        const lower = protection.scaleLower
        return (
          Number.isFinite(lower) &&
          lower > 0 &&
          deletionCurrent(lower) &&
          full.every((r) => strictInside(nativeCrop, expand(r, 1, lower))) &&
          foreignDomains.every((r) => !valid(r) || !over(mask, expand(r, 3, lower)))
        )
      }
    assert(inputCurrent && outputCurrent && current())
    states.set(proof, { table, current, kind: 'single-closing-body', rasterCurrent })
    return proof
  } catch {
    return
  }
}

// The scalar claims may cross a peer, but neither their meaning nor ownership
// is repaired here. A complete native rail/label pair owns only these pixels.
function proveRailPeerBody(table, rules, context, options) {
  try {
    const n = context.nativeGlyphContext,
      v = context.viewport,
      sourceContent = context.sourceContent,
      nativeContent = options.nativeContent,
      { page, captions, competingRects, otherFigures } = options,
      old = table.cropRect?.map((x) => x / v.scale),
      strictInside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i]))
    assert(n && valid(old) && v.scale > 0 && v.rotation === 0)
    assert(
      n.viewport.scale === 1 &&
        n.viewport.rotation === 0 &&
        v.width === n.viewport.width * v.scale &&
        v.height === n.viewport.height * v.scale &&
        same(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) &&
        table.sourceViewport?.scale === v.scale &&
        table.sourceViewport.width === v.width &&
        table.sourceViewport.height === v.height &&
        page.pageNumber === table.page
    )
    assert(
      !table.caption &&
        table.captionIssue === 'shared-table-caption' &&
        !table.parts &&
        !table.cropRects &&
        !table.notes?.length &&
        !table.unassigned?.length &&
        same([...table.issues].sort(), [
          'span-conflicts-with-source-rows',
          'text-crosses-crop-boundary'
        ]) &&
        Array.isArray(table.grid) &&
        Array.isArray(table.cells) &&
        Array.isArray(captions) &&
        Array.isArray(competingRects) &&
        Array.isArray(otherFigures)
    )
    const witness = capture(table, context, options)
    assert(witness && witness.patternOperations.length === 0)
    const tokens = n.content.items
        .filter((r) => r.str.trim())
        .map((r) => tableTextToken(r, n.viewport, 0)),
      p = nativePageTextPacketInventory(page, tokens, n)
    assert(
      p &&
        p.records.length <= 4096 &&
        p.glyphs.length <= 100000 &&
        p.evidence.images.length === 0 &&
        p.evidence.paths.size <= 4096
    )
    const paths = [...p.evidence.paths].map(([operationIndex, state]) => {
        const support = nativeFigurePathPaint(p, operationIndex, state)
        assert(support && valid(support.rect))
        let rail
        try {
          const q = ruledPath(n, p.evidence, operationIndex),
            a = p.o.argsArray[operationIndex],
            data = Array.from(a?.[1]?.[0] ?? [])
          if (
            a[0] === OPS.stroke &&
            data.length === 6 &&
            data[0] === 0 &&
            data[3] === 1 &&
            data[2] === data[5] &&
            q.ink[2] > q.ink[0]
          )
            rail = q.ink
        } catch {
          /* Other full page paths stay foreign; none is silently dropped. */
        }
        return { operationIndex, state, support, rail }
      }),
      groups = new Map()
    for (const q of paths.filter((q) => q.rail)) {
      const key = JSON.stringify([q.rail[0], q.rail[2]])
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(q)
    }
    const panels = [...groups.values()]
      .filter((g) => g.length === 5)
      .map((rails) => {
        rails.sort((a, b) => a.rail[1] - b.rail[1])
        assert(rails.every((q, i) => !i || rails[i - 1].rail[3] < q.rail[1]))
        const frame = union(rails.map((q) => q.rail)),
          body = p.records.filter((r) => over(r.rect, frame))
        assert(body.length >= 10 && body.every((r) => strictInside(frame, r.rect)))
        const labels = p.records.filter((r) => {
          const em = r.r.height
          return (
            /^\([a-z]\)\s+\S/u.test(r.r.str) &&
            r.rect[3] < frame[1] &&
            frame[1] - r.rect[3] < em * 2 &&
            r.rect[0] >= frame[0] &&
            r.rect[2] <= frame[2] &&
            Math.abs((r.rect[0] + r.rect[2] - frame[0] - frame[2]) / 2) < em / 2
          )
        })
        assert(labels.length === 1)
        return { rails, frame, body, label: labels[0] }
      })
      .sort((a, b) => a.frame[0] - b.frame[0])
    assert(panels.length === 2 && panels[0].frame[2] < panels[1].frame[0])
    const [left, right] = panels
    assert(
      left.rails.every((q, i) =>
        same(
          q.rail.slice(1).filter((_, k) => k !== 1),
          right.rails[i].rail.slice(1).filter((_, k) => k !== 1)
        )
      )
    )
    assert(
      left.label.r.str.charCodeAt(1) + 1 === right.label.r.str.charCodeAt(1) &&
        left.label.r.fontName === right.label.r.fontName &&
        left.label.r.height === right.label.r.height &&
        same(left.label.r.transform.slice(1, 4), right.label.r.transform.slice(1, 4)) &&
        left.label.r.transform[5] === right.label.r.transform[5]
    )
    const common = captions.filter(
      (c) =>
        c.page === table.page &&
        valid(c.rect) &&
        !c.regions &&
        Array.isArray(c.lines) &&
        /^Table\s+[A-Z]?\d+[.:](?=\s|$)/u.test(c.lines[0]) &&
        c.rect[3] < Math.min(left.label.rect[1], right.label.rect[1]) &&
        c.rect[0] <= left.frame[0] &&
        c.rect[2] >= right.frame[2]
    )
    assert(common.length === 1)
    const caption = common[0],
      title = p.records.filter((r) => over(r.rect, caption.rect))
    assert(
      title.length &&
        title.every((r) => strictInside(caption.rect, r.rect)) &&
        compact(title.map((r) => r.r.str).join('')) === compact(caption.lines.join(' ')) &&
        // Same pre-existing captionRecords boundary contract: group-page-line
        // addition can differ from a whole Source union by an original ULP.
        union(title.map((r) => r.rect)).every((x, i) => Math.abs(x - caption.rect[i]) < 1e-6)
    )
    const member = new Set([...left.body, ...right.body, left.label, right.label, ...title]),
      corridor = [
        left.frame[0],
        caption.rect[3],
        right.frame[2],
        Math.max(left.label.rect[3], right.label.rect[3])
      ]
    assert(p.records.every((r) => member.has(r) || !over(corridor, r.rect)))
    const records = new Map(p.records.map((r) => [r.index, r])),
      claims = new Set()
    for (const cell of table.cells) {
      assert(
        !cell.sourceSegments?.length &&
          (cell.sourceItems?.length ?? 0) === (cell.sourceRects?.length ?? 0)
      )
      for (const [i, source] of (cell.sourceItems ?? []).entries()) {
        const r = records.get(source.index)
        assert(
          r &&
            !claims.has(source.index) &&
            source.pageNumber === table.page &&
            source.text === r.r.str &&
            sourceContent.items[source.index].sourceItem?.pageNumber === table.page &&
            sourceContent.items[source.index].sourceItem.index === source.index &&
            sourceContent.items[source.index].sourceItem.text === source.text &&
            same(tableTextToken(sourceContent.items[source.index], v, 0).rect, cell.sourceRects[i])
        )
        claims.add(source.index)
      }
    }
    assert(claims.size === table.selectedTextItems && claims.size >= 10)
    const selected = panels.filter(
      (q) =>
        (old[0] + old[2]) / 2 > q.frame[0] &&
        (old[0] + old[2]) / 2 < q.frame[2] &&
        q.body.every((r) => claims.has(r.index))
    )
    assert(selected.length === 1)
    const own = selected[0],
      peer = panels.find((q) => q !== own),
      bodySet = new Set([...own.body, ...peer.body].map((r) => r.index))
    assert([...claims].every((i) => bodySet.has(i)))
    const owned = [...own.body, own.label],
      peerRecords = [...peer.body, peer.label],
      ownSet = new Set(owned.map((r) => r.index)),
      ownGlyphs = new Set(owned.flatMap((r) => r.part.map(({ g }) => g))),
      peerGlyphs = new Set(peerRecords.flatMap((r) => r.part.map(({ g }) => g))),
      ownPaths = new Set(own.rails),
      peerPaths = new Set(peer.rails),
      s = Math.min(MAX_SCALE, MAX_EDGE / Math.max(old[2] - old[0], old[3] - old[1])),
      expand = (r, pixels = 1, scale = s) =>
        r.map((x, i) => x + (i < 2 ? -pixels / scale : pixels / scale)),
      ownInk = [...ownGlyphs].map((g) => g.ink).concat(own.rails.map((q) => q.rail)),
      full = [...owned.map((r) => r.rect), ...[...ownGlyphs].map((g) => g.advance)],
      mask = expand(union(ownInk)),
      envelope = expand(union([...ownInk, ...full])),
      offset = envelope.map((x, i) => (i < 2 ? Math.floor : Math.ceil)((x - old[i]) * s)),
      nativeCrop = old.map((x, i) => x + offset[i] / s)
    assert(
      valid(mask) &&
        valid(nativeCrop) &&
        strictInside(nativeCrop, mask) &&
        strictInside([0, 0, n.viewport.width, n.viewport.height], nativeCrop) &&
        Math.min(
          MAX_SCALE,
          MAX_EDGE / Math.max(nativeCrop[2] - nativeCrop[0], nativeCrop[3] - nativeCrop[1])
        ) === s
    )
    assert(
      owned
        .concat(peerRecords)
        .every(
          (r) =>
            r.part.length &&
            r.part.every(
              ({ g }) =>
                valid(g.ink) &&
                valid(g.advance) &&
                g.height > 0 &&
                g.textPaint.fillAlpha === 1 &&
                p.evidence.texts.get(g.i)?.clip &&
                strictInside(p.evidence.texts.get(g.i).clip, expand(g.ink))
            )
        )
    )
    assert(own.rails.concat(peer.rails).every((q) => strictInside(q.state.clip, expand(q.rail))))
    const foreignGlyphs = p.glyphs.filter((g) => !ownGlyphs.has(g)),
      foreignPaths = paths.filter((q) => !ownPaths.has(q)),
      foreignSources = n.content.items.flatMap((r, index) => {
        assert(typeof r.str === 'string')
        const rect = tableTextToken(r, n.viewport, 0).rect
        assert(rect.every(Number.isFinite) && rect[0] <= rect[2] && rect[1] <= rect[3])
        return ownSet.has(index) ? [] : [rect]
      }),
      foreignDomains = [
        ...foreignSources,
        ...foreignGlyphs.flatMap((g) => [g.ink, g.advance]),
        ...foreignPaths.map((q) => q.rail ?? q.support.rect)
      ],
      foreign = [...peerGlyphs].map((g) => g.ink).concat(peer.rails.map((q) => q.rail)),
      deletionCurrent = (scale) =>
        foreignPaths.every(
          (q) =>
            peerPaths.has(q) ||
            [old, nativeCrop].every((crop) => !over(expand(q.support.rect, 3, scale), crop))
        ) &&
        foreignGlyphs.every(
          (g) =>
            peerGlyphs.has(g) ||
            [g.ink, g.advance].every(
              (r) =>
                !valid(r) || [old, nativeCrop].every((crop) => !over(expand(r, 3, scale), crop))
            )
        )
    assert(foreign.some((r) => over(r, old)))
    assert(
      foreignDomains.every(
        (r) =>
          Array.isArray(r) &&
          r.length === 4 &&
          r.every(Number.isFinite) &&
          r[0] <= r[2] &&
          r[1] <= r[3]
      )
    )
    assert(foreignGlyphs.every((g) => valid(g.ink) && valid(g.advance)))
    const domainsCurrent = (scale) =>
      deletionCurrent(scale) &&
      full.every((r) => strictInside(nativeCrop, expand(r, 1, scale))) &&
      foreignDomains.every((r) => !valid(r) || !over(mask, expand(r, 3, scale)))
    assert(domainsCurrent(s))
    assert(
      [
        ...competingRects,
        ...otherFigures
          .filter((f) => f.page === table.page && f.region)
          .map((f) => f.region.map((x, i) => x * (i % 2 ? n.viewport.height : n.viewport.width)))
      ].every((r) => valid(r) && !over(r, nativeCrop))
    )
    const proof = {
        cropRect: nativeCrop.map((x) => x * v.scale),
        nativeCrop,
        oldNativeCrop: old,
        regions: [mask],
        offset,
        rasterScale: s,
        pixelWidth: Math.ceil((nativeCrop[2] - nativeCrop[0]) * s),
        pixelHeight: Math.ceil((nativeCrop[3] - nativeCrop[1]) * s),
        bounds: { width: n.viewport.width, height: n.viewport.height },
        ownInk,
        foreign
      },
      inputCurrent = retainNativeRecoveryInputs(
        [
          table,
          rules,
          n,
          sourceContent,
          nativeContent,
          page,
          captions,
          competingRects,
          otherFigures
        ],
        v,
        n.viewport
      ),
      outputCurrent = retainNativeRecoveryInputs([proof]),
      current = () =>
        inputCurrent?.() &&
        outputCurrent?.() &&
        witness.current() &&
        context.nativeGlyphContext === n &&
        context.viewport === v &&
        context.sourceContent === sourceContent &&
        options.nativeContent === nativeContent &&
        options.page === page &&
        options.captions === captions &&
        options.competingRects === competingRects &&
        options.otherFigures === otherFigures &&
        !!nativePageTextPacketInventory(page, tokens, n),
      rasterCurrent = (png) => {
        const protection = getPdfCropRasterProtectionFromPng(png, nativeCrop, proof.bounds)
        return (
          protection &&
          Number.isFinite(protection.scaleLower) &&
          protection.scaleLower > 0 &&
          domainsCurrent(protection.scaleLower)
        )
      }
    assert(inputCurrent && outputCurrent && current())
    states.set(proof, { table, current, kind: 'rail-peer-body', rasterCurrent })
    return proof
  } catch {
    return
  }
}
