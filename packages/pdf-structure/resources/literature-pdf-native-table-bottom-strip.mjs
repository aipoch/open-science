/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Crop-only physical proof for an ambiguous mathematical three-line table.
// It never certifies scalar cells or clears the existing structural fallback.
import assert from 'node:assert/strict'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { getPdfCropRasterProtectionFromPng, MAX_EDGE, MAX_SCALE } from './literature-pdf-crop.mjs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { captureNativeTableCropWitness } from './literature-pdf-native-table-crop-witness.mjs'

const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  compact = (s) => s.normalize('NFD').replace(/\s/gu, ''),
  over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6))
const bindings = new WeakMap(),
  tableOwners = new WeakMap(),
  images = new WeakMap()
export function proveNativeTableBottomStrip(
  table,
  rules,
  context,
  { page, nativePage, nativeContent, captions, competingRects }
) {
  try {
    const n = context.nativeGlyphContext,
      v = context.viewport,
      raw = n?.content?.items,
      scale = v?.scale,
      old = table?.cropRect
    assert(
      n &&
        n.viewport.scale === 1 &&
        n.viewport.rotation === 0 &&
        page.invalidGraphicsBounds === 0 &&
        page.pageNumber === table.page
    )
    assert(
      raw?.length &&
        raw.length <= 4096 &&
        raw.length === nativeContent.items.length &&
        raw.length === context.sourceContent.items.length
    )
    assert(
      same(n.graphicsBounds, page.graphicsBounds) &&
        same(n.viewport.transform, [1, 0, 0, -1, 0, n.viewport.height])
    )
    assert(
      scale > 0 &&
        v.rotation === 0 &&
        same(v.transform, [scale, 0, 0, -scale, 0, v.height]) &&
        v.width === n.viewport.width * scale &&
        v.height === n.viewport.height * scale
    )
    assert(
      table.sourceViewport?.width === v.width &&
        table.sourceViewport?.height === v.height &&
        table.sourceViewport?.scale === scale &&
        (table.sourceViewport?.rotation === undefined || table.sourceViewport.rotation === 0)
    )
    assert(
      valid(old) &&
        table.parts === undefined &&
        table.cropRects === undefined &&
        table.caption?.page === table.page &&
        !table.caption.regions &&
        valid(table.caption.rect) &&
        /^Table\s+\d+[:.]/u.test(table.caption.text)
    )
    assert(
      Array.isArray(table.clipped) &&
        table.clipped.length > 0 &&
        table.clipped.length <= 64 &&
        table.clipped.every((c) => valid(c.rect))
    )
    assert(
      Array.isArray(table.issues) &&
        table.issues.includes('text-crosses-crop-boundary') &&
        (!table.notes || table.notes.length === 0)
    )
    assert(
      Array.isArray(captions) &&
        captions.filter(
          (c) =>
            c.page === table.page &&
            same(c.rect, table.caption.rect) &&
            compact(c.text ?? c.lines.join(' ')) === compact(table.caption.text)
        ).length === 1
    )
    assert(Array.isArray(competingRects) && competingRects.every(valid))
    const witness = captureNativeTableCropWitness(table, context, {
      page,
      nativePage,
      nativeContent
    })
    if (!witness || witness.patternOperations.length) return
    const { records, glyphs, e } = witness
    const families = new Map()
    for (const r of rules.filter(
      (r) =>
        r[1] === r[3] && r[0] >= old[0] && r[2] <= old[2] && r[2] - r[0] >= (old[2] - old[0]) * 0.95
    )) {
      const key = r[0] + ':' + r[2]
      if (!families.has(key)) families.set(key, [])
      families.get(key).push(r)
    }
    const candidates = []
    for (const rails of families.values()) {
      rails.sort((a, b) => a[1] - b[1])
      if (rails.length !== 3) continue
      const paints = rails.map((r) => context.rulePaintBounds.get(r.join(',')))
      if (
        !paints.every(valid) ||
        paints[0][1] < old[1] ||
        paints[1][3] >= old[3] ||
        paints[2][1] <= old[3]
      )
        continue
      const crop = [...old]
      crop[3] = paints[2][3]
      const nativeCrop = crop.map((n) => n / scale),
        frame = [
          paints[0][0] / scale,
          paints[0][1] / scale,
          paints[0][2] / scale,
          paints[2][3] / scale
        ],
        oldNative = old.map((n) => n / scale)
      if (!table.clipped.every((c) => inside(crop, c.rect))) continue
      const source = records.filter((r) => over(r.ink, nativeCrop)),
        foreign = records.filter((r) => !source.includes(r)),
        loose = records.filter((r) => !r.horizontalComplete)
      if (
        !source.length ||
        source.some((r) => !inside(frame, r.ink)) ||
        !loose.length ||
        loose.some((r) => raw[r.index].width !== 0 || !inside(oldNative, r.ink))
      )
        continue
      const clippedSources = table.clipped.map((c) =>
        records.filter(
          (r) =>
            r.text === c.text &&
            same(
              r.sourceRect.map((n) => n * scale),
              c.rect
            )
        )
      )
      if (
        clippedSources.some(
          (a) => a.length !== 1 || !a[0].horizontalComplete || !source.includes(a[0])
        )
      )
        continue
      const caption = records.filter((r) => over(r.sourceRect, table.caption.rect))
      if (
        !caption.length ||
        caption.some((r) => !r.horizontalComplete) ||
        compact(caption.map((r) => r.text).join('')) !== compact(table.caption.text)
      )
        continue
      const ownPaths = [],
        foreignPaths = []
      for (const g of n.graphicsBounds) {
        const coarse = g.normalizedRect.map(
          (v, i) => v * (i % 2 ? n.viewport.height : n.viewport.width)
        )
        if (!over(coarse, nativeCrop)) {
          foreignPaths.push(coarse)
          continue
        }
        const a = n.operators.argsArray[g.operationIndex],
          s = e.paths.get(g.operationIndex),
          q = Array.from(a?.[1]?.[0] ?? []),
          m = Util.transform(n.viewport.transform, s.transform)
        if (
          a[0] !== OPS.stroke ||
          q.length !== 6 ||
          q[0] !== 0 ||
          q[3] !== 1 ||
          !q.every(Number.isFinite) ||
          m[1] !== 0 ||
          m[2] !== 0 ||
          m[0] <= 0 ||
          m[3] !== -m[0] ||
          s.lineCap !== 0 ||
          s.solidStroke !== true ||
          s.strokeAlpha !== 1 ||
          !valid(s.clip) ||
          !(s.lineWidth > 0)
        )
          throw Error('Unproved owned path')
        const p = [q[1], q[2]],
          r = [q[4], q[5]]
        Util.applyTransform(p, m)
        Util.applyTransform(r, m)
        if (p[1] !== r[1]) throw Error('Nonhorizontal owned path')
        const b = [
          Math.min(p[0], r[0]),
          p[1] - (s.lineWidth * m[0]) / 2,
          Math.max(p[0], r[0]),
          p[1] + (s.lineWidth * m[0]) / 2
        ]
        if (!inside(frame, b) || !inside(s.clip, b)) throw Error('Unclosed owned stroke')
        ownPaths.push({ operationIndex: g.operationIndex, ink: b })
      }
      if (
        ownPaths.length < 3 ||
        !ownPaths.some((p) => p.ink.every((n, i) => Math.abs(n * scale - paints[2][i]) < 1e-6))
      )
        continue
      const retainedOpaquePaint = glyphs.filter((g) => !compact(g.text) && valid(g.ink))
      if (retainedOpaquePaint.some((g) => !inside(oldNative, g.ink) || !inside(frame, g.ink)))
        continue
      const foreignGlyphs = foreign.map((r) => r.ink)
      const width = nativeCrop[2] - nativeCrop[0],
        height = nativeCrop[3] - nativeCrop[1],
        rasterScale = Math.min(MAX_SCALE, MAX_EDGE / Math.max(width, height)),
        pixelWidth = Math.ceil(width * rasterScale),
        pixelHeight = Math.ceil(height * rasterScale)
      // Protect ceil pixels and one AA pixel using the same conservative interval
      // as the post-PNG public guard; do not add padding to the actual crop.
      const lower =
          Math.max((pixelWidth - 1) / width, (pixelHeight - 1) / height) * (1 - 8 * Number.EPSILON),
        protection = [
          nativeCrop[0] - 1 / lower,
          nativeCrop[1] - 1 / lower,
          nativeCrop[0] + pixelWidth / lower + 1 / lower,
          nativeCrop[1] + pixelHeight / lower + 1 / lower
        ]
      if (
        [...foreignGlyphs, ...foreignPaths, ...competingRects, ...captions.map((c) => c.rect)].some(
          (r) => over(r, protection)
        )
      )
        continue
      candidates.push({
        cropRect: crop,
        nativeCrop,
        bounds: { width: n.viewport.width, height: n.viewport.height },
        foreignGlyphs,
        foreignPaths,
        competingRects,
        captionRects: captions.map((c) => c.rect),
        pixelWidth,
        pixelHeight,
        oldNativeCrop: oldNative,
        retainedOpaquePaint: retainedOpaquePaint.map((g) => ({
          operationIndex: g.op,
          index: g.index,
          font: g.font,
          text: g.text,
          ink: g.ink
        })),
        affectedGlyphs: clippedSources.map((a) => a[0].ink),
        sourceItems: source.map((r) => ({ pageNumber: table.page, index: r.index, text: r.text })),
        claimedClippedSources: clippedSources.map((a) => a[0].index),
        structuralWarnings: table.issues.filter((i) => i !== 'text-crosses-crop-boundary'),
        clipped: [],
        ownPaths
      })
    }
    if (candidates.length !== 1) return
    const proof = candidates[0],
      proofValue = JSON.stringify(proof),
      proofCurrent = () => {
        const value = { ...proof }
        delete value.pixelPreservation
        return JSON.stringify(value) === proofValue
      },
      readRefs = () => [
        table.cells,
        table.unassigned,
        table.grid,
        context.sourceContent,
        context.sourceContent.items,
        context.sourceContent.styles,
        n.content,
        n.content.items,
        n.content.styles,
        n.operators,
        n.operators.fnArray,
        n.operators.argsArray,
        n.glyphBounds,
        n.skippedSpaceGlyphs,
        n.graphicsBounds,
        context.viewport,
        context.rulePaintBounds,
        nativeContent,
        nativeContent.items,
        nativeContent.styles,
        page.graphicsBounds,
        captions,
        competingRects,
        nativePage.commonObjs,
        nativePage.commonObjs.get
      ],
      refs = readRefs(),
      identity = JSON.stringify({
        table,
        raw,
        sourceContent: context.sourceContent,
        nativeContent,
        operators: n.operators,
        glyphBounds: n.glyphBounds,
        skipped: n.skippedSpaceGlyphs,
        graphics: n.graphicsBounds,
        viewport: context.viewport,
        rulePaintBounds: [...context.rulePaintBounds],
        captions,
        competingRects
      }),
      fontCurrent = witness.current
    tableOwners.set(proof, table)
    bindings.set(
      proof,
      () =>
        proofCurrent() &&
        readRefs().every((r, i) => r === refs[i]) &&
        identity ===
          JSON.stringify({
            table,
            raw,
            sourceContent: context.sourceContent,
            nativeContent,
            operators: n.operators,
            glyphBounds: n.glyphBounds,
            skipped: n.skippedSpaceGlyphs,
            graphics: n.graphicsBounds,
            viewport: context.viewport,
            rulePaintBounds: [...context.rulePaintBounds],
            captions,
            competingRects
          }) &&
        fontCurrent()
    )
    return proof
  } catch {
    return
  }
}
function validate(png, proof) {
  try {
    if (!bindings.get(proof)?.()) return false
    const raster = getPdfCropRasterProtectionFromPng(png, proof.nativeCrop, proof.bounds)
    if (
      !raster ||
      raster.pixelWidth !== proof.pixelWidth ||
      raster.pixelHeight !== proof.pixelHeight
    )
      return false
    return [
      ...proof.foreignGlyphs,
      ...proof.foreignPaths,
      ...proof.competingRects,
      ...proof.captionRects
    ].every((r) => !over(r, raster.protection))
  } catch {
    return false
  }
}

async function validatePreservation(oldPng, png, proof) {
  try {
    if (!validate(png, proof)) return false
    const oldBytes = Uint8Array.from(oldPng),
      newBytes = Uint8Array.from(png),
      imageCurrent = () =>
        oldPng.length === oldBytes.length &&
        png.length === newBytes.length &&
        oldPng.every((v, i) => v === oldBytes[i]) &&
        png.every((v, i) => v === newBytes[i])
    const old = await loadImage(oldPng)
    if (!bindings.get(proof)?.() || !imageCurrent()) return false
    const next = await loadImage(png)
    if (!bindings.get(proof)?.() || !imageCurrent()) return false
    const r = proof.oldNativeCrop,
      s = Math.min(MAX_SCALE, MAX_EDGE / Math.max(r[2] - r[0], r[3] - r[1]))
    if (
      old.width !== next.width ||
      old.width !== Math.ceil((r[2] - r[0]) * s) ||
      old.height !== Math.ceil((r[3] - r[1]) * s) ||
      next.height !== proof.pixelHeight
    )
      return false
    const rgba = (image) => {
        const c = createCanvas(image.width, image.height),
          ctx = c.getContext('2d')
        ctx.drawImage(image, 0, 0)
        const data = ctx.getImageData(0, 0, image.width, image.height).data
        c.width = c.height = 1
        return data
      },
      a = rgba(old),
      b = rgba(next),
      allowed = proof.affectedGlyphs.map((g) => [
        (g[0] - r[0]) * s - 1,
        (g[1] - r[1]) * s - 1,
        (g[2] - r[0]) * s + 1,
        (g[3] - r[1]) * s + 1
      ])
    let changed = 0
    for (let p = 0; p < old.width * old.height; p++) {
      if ([0, 1, 2, 3].every((k) => a[p * 4 + k] === b[p * 4 + k])) continue
      const x = p % old.width,
        y = Math.floor(p / old.width)
      if (!allowed.some((r) => x >= r[0] && y >= r[1] && x <= r[2] && y <= r[3])) return false
      changed++
    }
    const newOwned = [...proof.affectedGlyphs, ...proof.ownPaths.map((p) => p.ink)].map((g) => [
      (g[0] - r[0]) * s - 1,
      (g[1] - r[1]) * s - 1,
      (g[2] - r[0]) * s + 1,
      (g[3] - r[1]) * s + 1
    ])
    for (let p = old.width * old.height; p < next.width * next.height; p++) {
      if (b[p * 4] === 255 && b[p * 4 + 1] === 255 && b[p * 4 + 2] === 255 && b[p * 4 + 3] === 255)
        continue
      const x = p % next.width,
        y = Math.floor(p / next.width)
      if (!newOwned.some((r) => x >= r[0] && y >= r[1] && x <= r[2] && y <= r[3])) return false
    }
    proof.pixelPreservation = {
      newVisiblePixelsOnlyWithinOwnedGlyphStrokeInk: true,
      oldPixels: old.width * old.height,
      changedPixels: changed,
      allChangesWithinWholeProvenAffectedGlyphs: true,
      retainedOpaquePaintUnchanged: true
    }
    if (!bindings.get(proof)?.() || !imageCurrent()) return false
    images.set(proof, { png, bytes: newBytes })
    return true
  } catch {
    return false
  }
}

export function commitNativeTableBottomStrip(proof, png) {
  try {
    const image = images.get(proof)
    if (
      !bindings.get(proof)?.() ||
      !image ||
      image.png !== png ||
      png.length !== image.bytes.length ||
      !png.every((v, i) => v === image.bytes[i])
    )
      return
    return {
      ...tableOwners.get(proof),
      cropRect: [...proof.cropRect],
      region: proof.cropRect.map(
        (n, i) =>
          n /
          (i % 2
            ? tableOwners.get(proof).sourceViewport.height
            : tableOwners.get(proof).sourceViewport.width)
      ),
      clipped: [],
      issues: [...proof.structuralWarnings]
    }
  } catch {
    return
  }
}
export async function renderNativeTableBottomStrip(proof, renderCrop) {
  try {
    if (!bindings.get(proof)?.()) return
    const oldPng = await renderCrop(proof.oldNativeCrop)
    if (!bindings.get(proof)?.()) return
    const png = await renderCrop(proof.nativeCrop)
    if (!bindings.get(proof)?.()) return
    if (!(await validatePreservation(oldPng, png, proof)) || !bindings.get(proof)?.()) return
    return png
  } catch {
    return
  }
}
