import {
  verifyNativeDualApiCertificate,
  verifyNativeLigatureApiCertificate
} from './literature-pdf-native-dual-api-certificate.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { captureNativeIsolatedRasterScope } from './literature-pdf-isolated-raster-scope.mjs'
import { nativeCompositingByteWindow } from './literature-pdf-native-compositing-profile.mjs'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { types } from 'node:util'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'
import { collectFilledGlyphEvidence } from './literature-pdf-filled-glyph-evidence.mjs'
import { Path2D } from '@napi-rs/canvas'
import { OPS, Util, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  captureNativeMesh4PixelResources,
  nativeMesh4PixelResourceData,
  sealNativeMesh4PixelResources
} from './literature-pdf-figure-native-mesh-resources.mjs'

const nativeGroupPaintMetadata = new WeakMap()
const nativeGraphicsBudgetBasis = new WeakMap()
const nativeRenderPaths = new WeakMap()
const nativeSnapshotRenderTasks = new WeakMap()
const nativeMesh4Snapshots = new WeakMap(),
  nativeMesh4Contexts = new WeakMap()

function inheritNativeMesh4Snapshot(source, target, reserved = 0) {
  const mesh = nativeMesh4Snapshots.get(source)
  if (!mesh || !mesh.current()) return
  const data = nativeMesh4PixelResourceData(mesh.handle, target.operators),
    allocation = Math.max(mesh.reserved ?? 0, reserved)
  if (data && nativeSnapshotSize(target, 16 * 1024 * 1024 - data.bytes - allocation) !== undefined)
    nativeMesh4Snapshots.set(target, { ...mesh, reserved: allocation })
}

// The extractor reads painted-operation boxes, not debugger dependency boxes.
// PDF.js propagates each box to every preceding transform, which is quadratic
// for long native vector streams. Keep its original bbox/clip/save machinery;
// omit only dependencies used to rerender a subset of operations in a debugger.
// This is an instance-local adapter to the same pinned private render API used
// by collectGraphicsBounds. Regular PDF rendering is unaffected.
export function recordPaintedOperationBounds(renderTask) {
  assert.equal(version, '5.4.624', 'Review the PDF render bounds adapter after upgrading PDF.js.')
  const tracker = renderTask?._internalRenderTask?._dependencyTracker
  assert(
    typeof tracker?.recordDependencies === 'function',
    'PDF render bounds tracker is unavailable.'
  )
  tracker.recordDependencies = function () {
    return this
  }
  recordNativeFigurePaths(renderTask)
}

export function recordNativeFigurePaths(renderTask) {
  assert.equal(version, '5.4.624', 'Review the PDF native path observer after upgrading PDF.js.')
  const operators = renderTask?._internalRenderTask?.operatorList
  assert(Array.isArray(operators?.fnArray), 'PDF native render stream is unavailable.')
  if (nativeRenderPaths.has(renderTask)) return
  // CanvasGraphics replaces raw path commands with an opaque Path2D after
  // execution. Retain those exact commands at the existing index before that
  // mutation; neither OPLIST indices nor a reconstructed rectangle can replace
  // the original render-stream path provenance.
  const state = {
    paths: new Map(),
    bytes: 0,
    buffers: new Set(),
    overflow: false,
    scanned: 0,
    pixelType3: new Map(),
    pixelType3Bytes: 0,
    pixelType3Failed: false,
    pixelType3Hooked: false
  }
  nativeRenderPaths.set(renderTask, state)
  const scanPendingPaths = () => {
    observeNativeGroupPaintMetadata(renderTask, operators)
    observeNativePixelType3(renderTask, state)
    if (operators.fnArray.length > 100000) {
      state.overflow = true
      state.paths.clear()
      state.buffers.clear()
      discardNativePixelType3(state)
    }
    for (; !state.overflow && state.scanned < operators.fnArray.length; state.scanned++) {
      const index = state.scanned
      if (operators.fnArray[index] === OPS.constructPath) {
        const args = operators.argsArray[index],
          path = args?.[1]?.[0]
        if (ArrayBuffer.isView(path) || Array.isArray(path) || path == null) {
          const pathBytes =
            128 +
            (Array.isArray(path) ? path.length * 8 : 0) +
            (ArrayBuffer.isView(path) && !state.buffers.has(path.buffer)
              ? path.buffer.byteLength
              : 0)
          // The optional nested family never reserves space ahead of old paint.
          // Release it before the next top-level record consumes shared space.
          if (state.pixelType3Bytes > 16 * 1024 * 1024 - state.bytes - pathBytes)
            discardNativePixelType3(state)
          state.bytes += 128 + (Array.isArray(path) ? path.length * 8 : 0)
          if (ArrayBuffer.isView(path) && !state.buffers.has(path.buffer)) {
            state.buffers.add(path.buffer)
            state.bytes += path.buffer.byteLength
          }
          if (state.bytes > 16 * 1024 * 1024) {
            state.overflow = true
            state.paths.clear()
            state.buffers.clear()
            discardNativePixelType3(state)
          } else state.paths.set(index, [args[0], [path], args[2]])
        }
      } else if (
        [OPS.setFillColorN, OPS.setStrokeColorN].includes(operators.fnArray[index]) &&
        operators.argsArray[index]?.[0] === 'TilingPattern'
      ) {
        // Tiling patterns own nested operator lists. CanvasGraphics mutates
        // their constructPath arguments too, outside the top-level stream.
        // Preserve the bounded original arguments at this exact operation.
        const args = operators.argsArray[index]
        try {
          const size = nativeSnapshotSize(args, 16 * 1024 * 1024 - state.bytes)
          if (size === undefined) throw new Error('Unproved native pattern snapshot')
          if (state.pixelType3Bytes > 16 * 1024 * 1024 - state.bytes - size)
            discardNativePixelType3(state)
          state.paths.set(index, structuredClone(args))
          state.bytes += size
        } catch {
          state.overflow = true
          state.paths.clear()
          state.buffers.clear()
          discardNativePixelType3(state)
        }
      }
    }
  }
  const internal = renderTask._internalRenderTask,
    previousChanged = internal.operatorListChanged
  if (typeof previousChanged === 'function') {
    // Appended chunks can arrive after onContinue but before its queued
    // execution. PDF.js skips another continuation while running; observe the
    // new tail synchronously before that notification can execute any paths.
    internal.operatorListChanged = function (...args) {
      scanPendingPaths()
      return previousChanged.apply(this, args)
    }
  }
  const previousContinue = renderTask.onContinue
  renderTask.onContinue = (resume) => {
    // Retain initial operations too, including clip-only paths that never call
    // the painted-box tracker. The cursor prevents rescanning appended chunks.
    scanPendingPaths()
    if (previousContinue) previousContinue.call(renderTask, resume)
    else resume()
  }
}

function discardNativePixelType3(state) {
  state.pixelType3Failed = true
  state.pixelType3.clear()
  state.pixelType3Bytes = 0
}

// Observe the original Type3 IR immediately before the pinned renderer consumes
// it. This separate optional family is crop-only; it never fills glyphBounds.
function observeNativePixelType3(renderTask, state) {
  const graphics = renderTask?._internalRenderTask?.gfx
  if (!graphics || state.pixelType3Hooked) return
  const show = graphics.showType3Text
  if (typeof show !== 'function') return
  state.pixelType3Hooked = true
  graphics.showType3Text = function (operationIndex, glyphs) {
    try {
      if (!state.pixelType3Failed) {
        const font = this.current.font,
          name = font.loadedName
        if (font.isType3Font !== true || typeof name !== 'string' || !Array.isArray(glyphs))
          throw new Error('Incomplete Type3 execution')
        let entry = state.pixelType3.get(name)
        if (!entry) {
          entry = {
            fontName: name,
            fontMatrix: Array.from(font.fontMatrix ?? []),
            missingFile: font.missingFile,
            isInvalidPDFjsFont: font.isInvalidPDFjsFont,
            vertical: font.vertical,
            glyphs: []
          }
          const fontBytes = nativeSnapshotSize(
            [...state.pixelType3.values(), entry],
            16 * 1024 * 1024 - state.bytes
          )
          if (fontBytes === undefined) throw new Error('Unbounded Type3 font')
          state.pixelType3.set(name, entry)
          state.pixelType3Bytes = fontBytes
        }
        for (const [glyphIndex, glyph] of glyphs.entries()) {
          if (typeof glyph === 'number') continue
          let row = entry.glyphs.find((g) => g.operatorListId === glyph.operatorListId)
          if (!row) {
            const original = font.charProcOperatorList?.[glyph.operatorListId]
            row = {
              operatorListId: glyph.operatorListId,
              unicode: glyph.unicode,
              fontChar: glyph.fontChar,
              originalCharCode: glyph.originalCharCode,
              width: glyph.width,
              isSpace: glyph.isSpace,
              isInFont: glyph.isInFont,
              program: original,
              occurrences: []
            }
            // Check the complete accumulated optional family against the
            // remaining old allowance before allocating another raw clone.
            const probe = [...state.pixelType3.values()].map((f) =>
              f === entry ? { ...f, glyphs: [...f.glyphs, row] } : f
            )
            const programBytes = nativeSnapshotSize(probe, 16 * 1024 * 1024 - state.bytes)
            if (programBytes === undefined) throw new Error('Unbounded Type3 program')
            row = structuredClone(row)
            entry.glyphs.push(row)
            state.pixelType3Bytes = programBytes
          }
          if (
            ![
              'operatorListId',
              'unicode',
              'fontChar',
              'originalCharCode',
              'width',
              'isSpace',
              'isInFont'
            ].every((key) => row[key] === glyph[key]) ||
            glyph.accent != null ||
            glyph.vmetric != null
          )
            throw new Error('Inconsistent Type3 occurrence')
          const occurrence = { operationIndex, glyphIndex },
            remaining = 16 * 1024 * 1024 - state.bytes - state.pixelType3Bytes,
            occurrenceBytes = nativeSnapshotSize(occurrence, remaining)
          // Include the new array slot before allocating an unbounded sequence.
          if (occurrenceBytes === undefined || occurrenceBytes + 8 > remaining)
            throw new Error('Type3 occurrence budget exhausted')
          row.occurrences.push(occurrence)
          state.pixelType3Bytes += occurrenceBytes + 8
        }
        // Share the existing fixed snapshot allowance; discard only this optional
        // family if later top-level paint consumes its remaining space.
        if (
          nativeSnapshotSize([...state.pixelType3.values()], 16 * 1024 * 1024 - state.bytes) ===
          undefined
        )
          throw new Error('Type3 snapshot budget exhausted')
      }
    } catch {
      discardNativePixelType3(state)
    }
    return show.call(this, operationIndex, glyphs)
  }
}

const finiteArray = (value, length) =>
  Array.isArray(value) && value.length === length && value.every(Number.isFinite)
const nativeViewportValue = (viewport) => ({
  width: viewport.width,
  height: viewport.height,
  scale: viewport.scale,
  rotation: viewport.rotation,
  transform: Array.from(viewport.transform)
})

function nativeSnapshotSize(value, budget) {
  const pending = [value],
    seen = new Set()
  let size = 0
  while (pending.length) {
    let item = pending.pop()
    const basis = item && typeof item === 'object' && nativeGraphicsBudgetBasis.get(item)
    if (basis) {
      if (!basis.current()) return
      item = basis.coarse
    }
    if (typeof item === 'string') size += item.length * 2
    else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item)
      if (ArrayBuffer.isView(item)) {
        size += 64
        pending.push(item.buffer)
      } else if (item instanceof ArrayBuffer) size += item.byteLength
      else if (Array.isArray(item)) {
        size += item.length * 8
        for (const child of item) pending.push(child)
      } else {
        const prototype = Object.getPrototypeOf(item)
        if (prototype !== Object.prototype && prototype !== null) return
        size += 64
        for (const [key, child] of Object.entries(item)) {
          size += key.length * 2 + 8
          pending.push(child)
        }
      }
    } else if (typeof item === 'function') return
    if (size > budget) return
  }
  return size
}

// Keep only a bounded, isolated native proof snapshot from the exact render
// stream that supplied operation indices. This is internal batch state, never
// worker-result data. Traverse before cloning so large decoded images abstain.
export function captureNativeFigureRenderContext(
  renderTask,
  pageNumber,
  content,
  viewport,
  graphicsBounds,
  sourceSha256,
  commonObjs
) {
  try {
    const task = renderTask?._internalRenderTask,
      operators = task?.operatorList,
      rendered = task?.params?.viewport,
      nativePaths = nativeRenderPaths.get(renderTask)
    if (
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1 ||
      !/^[a-f0-9]{64}$/.test(sourceSha256) ||
      !Array.isArray(operators?.fnArray) ||
      operators.fnArray.length !== operators.argsArray?.length ||
      operators.fnArray.length > 100000 ||
      !Array.isArray(content?.items) ||
      !content.styles ||
      !Array.isArray(graphicsBounds) ||
      nativePaths?.overflow ||
      !finiteArray(viewport?.transform, 6) ||
      viewport.scale !== 1 ||
      !(viewport.width > 0 && viewport.height > 0) ||
      !finiteArray(rendered?.transform, 6) ||
      !(rendered.scale > 0) ||
      rendered.rotation !== viewport.rotation ||
      task.params.transform ||
      Math.abs(rendered.width - viewport.width * rendered.scale) > 1e-7 ||
      Math.abs(rendered.height - viewport.height * rendered.scale) > 1e-7 ||
      rendered.transform.some((n, i) => Math.abs(n - viewport.transform[i] * rendered.scale) > 1e-7)
    )
      return
    const value = {
      sourceSha256,
      pageNumber,
      graphicsBounds,
      operators: {
        fnArray: operators.fnArray,
        argsArray: operators.argsArray.map((args, index) => nativePaths?.paths.get(index) ?? args)
      },
      viewport: nativeViewportValue(viewport),
      content: { items: content.items, styles: content.styles }
    }
    const size = nativeSnapshotSize(value, 16 * 1024 * 1024)
    if (size === undefined) return
    const snapshot = structuredClone(value)
    const graphicsBudget = nativeGraphicsBudgetBasis.get(graphicsBounds)
    if (graphicsBudget) nativeGraphicsBudgetBasis.set(snapshot.graphicsBounds, graphicsBudget)
    const glyphBounds = nativeGlyphBounds(operators, commonObjs, 16 * 1024 * 1024 - size)
    if (glyphBounds) snapshot.glyphBounds = glyphBounds
    // Keep the existing all-font proof unchanged. A Type3 or unavailable font
    // must not masquerade as complete evidence for consumers of glyphBounds.
    const partialFontGlyphBounds = glyphBounds
      ? undefined
      : nativePartialFontGlyphBounds(operators, commonObjs, 16 * 1024 * 1024 - size)
    if (partialFontGlyphBounds) snapshot.partialFontGlyphBounds = partialFontGlyphBounds
    // This records decoded RGB shape only, never copies pixels or infers alpha
    // from a thumbnail. Consumers must separately prove graphics state and clip.
    const glyphBytes =
      (glyphBounds ?? partialFontGlyphBounds)?.reduce(
        (sum, f) =>
          sum +
          256 +
          f.fontName.length * 2 +
          f.glyphs.reduce((n, g) => n + 256 + g.fontChar.length * 2, 0),
        0
      ) ?? 0
    const type3GlyphPrograms = nativeType3GlyphPrograms(
      operators,
      commonObjs,
      content,
      16 * 1024 * 1024 - size - glyphBytes
    )
    if (type3GlyphPrograms) snapshot.type3GlyphPrograms = type3GlyphPrograms
    const type3Bytes = type3GlyphPrograms
      ? nativeSnapshotSize(type3GlyphPrograms, 16 * 1024 * 1024)
      : 0
    const skippedSpaceGlyphs = nativeSkippedSpaceGlyphs(
      operators,
      commonObjs,
      16 * 1024 * 1024 - size - glyphBytes - type3Bytes
    )
    if (skippedSpaceGlyphs?.length) snapshot.skippedSpaceGlyphs = skippedSpaceGlyphs
    const skippedBytes = skippedSpaceGlyphs
      ? (nativeSnapshotSize(skippedSpaceGlyphs, 16 * 1024 * 1024) ?? 16 * 1024 * 1024)
      : 0
    const opaqueRasterImages = nativeOpaqueRasterImages(
      operators,
      task.objs,
      16 * 1024 * 1024 - size - glyphBytes - type3Bytes - skippedBytes
    )
    if (opaqueRasterImages?.length) snapshot.opaqueRasterImages = opaqueRasterImages
    // Optional precision never replaces coarse all-paint evidence or reduces
    // any existing evidence budget. Only a bounded overprint candidate is copied.
    const precisionBudget = Math.min(
      65536,
      16 * 1024 * 1024 -
        size -
        glyphBytes -
        type3Bytes -
        skippedBytes -
        (opaqueRasterImages ? nativeSnapshotSize(opaqueRasterImages, 16 * 1024 * 1024) : 0)
    )
    const filledGlyphEvidence =
      glyphBounds &&
      collectFilledGlyphEvidence(
        content,
        operators,
        commonObjs,
        glyphBounds,
        { sourceSha256, pageNumber },
        precisionBudget
      )
    if (filledGlyphEvidence) snapshot.filledGlyphEvidence = filledGlyphEvidence
    // A compound accent is additional same-font paint, never a replacement
    // for ordinary glyphBounds. Spend only space left after all old evidence.
    const retainedBytes = nativeSnapshotSize(snapshot, 16 * 1024 * 1024)
    const foreignCompoundGlyphs =
      retainedBytes === undefined
        ? undefined
        : nativeForeignCompoundGlyphs(
            operators,
            commonObjs,
            Math.min(65536, 16 * 1024 * 1024 - retainedBytes)
          )
    if (foreignCompoundGlyphs?.length) snapshot.foreignCompoundGlyphs = foreignCompoundGlyphs
    const pixelType3Programs = nativePaths?.pixelType3Failed
      ? undefined
      : [...(nativePaths?.pixelType3?.values() ?? [])]
    if (
      pixelType3Programs?.length &&
      nativeSnapshotSize({ ...snapshot, pixelType3Programs }, 16 * 1024 * 1024) !== undefined
    )
      snapshot.pixelType3Programs = structuredClone(pixelType3Programs)
    const isolatedRasterScope = captureNativeIsolatedRasterScope(snapshot, renderTask, nativePaths)
    if (
      isolatedRasterScope &&
      nativeSnapshotSize({ ...snapshot, isolatedRasterScope }, 16 * 1024 * 1024) !== undefined
    )
      snapshot.isolatedRasterScope = isolatedRasterScope
    nativeSnapshotRenderTasks.set(snapshot, new WeakRef(renderTask))
    const hasMesh = snapshot.operators.fnArray.some(
        (op, i) => op === OPS.setFillColorN && snapshot.operators.argsArray[i]?.[0] === 'Shading'
      ),
      meshBytes = hasMesh ? nativeSnapshotSize(snapshot, 16 * 1024 * 1024) : undefined,
      meshHandle =
        meshBytes !== undefined &&
        nativePaths &&
        !nativePaths.overflow &&
        captureNativeMesh4PixelResources(
          renderTask,
          snapshot.operators,
          16 * 1024 * 1024 - meshBytes
        ),
      meshCurrent = meshHandle && retainNativeRecoveryInputs([snapshot])
    if (meshCurrent)
      nativeMesh4Snapshots.set(snapshot, { handle: meshHandle, current: meshCurrent })
    return snapshot
  } catch {
    return
  }
}

// Optional raster evidence is last in the existing snapshot budget. Keep only
// its identity here; the job owns the bounded temporary PNG until consumption.
export function attachNativeCaptionLaneRaster(snapshot, renderTask, bytes, path) {
  try {
    const rendered = renderTask?._internalRenderTask?.params?.viewport
    if (
      nativeSnapshotRenderTasks.get(snapshot)?.deref() !== renderTask ||
      !rendered ||
      rendered.scale !== 1.5 ||
      !isAbsolute(path) ||
      path.length > 4096 ||
      !(bytes instanceof Uint8Array) ||
      !bytes.length ||
      bytes.length > 4 * 1024 * 1024
    )
      return
    const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (
      png.length < 24 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.toString('ascii', 12, 16) !== 'IHDR'
    )
      return
    const width = png.readUInt32BE(16),
      height = png.readUInt32BE(20)
    if (
      width !== Math.ceil(rendered.width) ||
      height !== Math.ceil(rendered.height) ||
      width !== Math.ceil(snapshot.viewport.width * 1.5) ||
      height !== Math.ceil(snapshot.viewport.height * 1.5) ||
      width * height > 4_000_000
    )
      return
    const result = {
      ...snapshot,
      captionLaneRaster: {
        page: snapshot.pageNumber,
        sourceSha256: snapshot.sourceSha256,
        scale: 1.5,
        width,
        height,
        sha256: createHash('sha256').update(png).digest('hex'),
        path
      }
    }
    const remaining = 16 * 1024 * 1024 - png.byteLength - width * height * 4
    if (!(remaining > 0) || nativeSnapshotSize(result, remaining) === undefined) return
    nativeSnapshotRenderTasks.set(result, new WeakRef(renderTask))
    inheritNativeMesh4Snapshot(snapshot, result, png.byteLength + width * height * 4)
    return result
  } catch {
    return
  }
}

// Separate PDF.js documents allocate different font cache names. Permit only a
// bijective rename with identical styles and every whole item at the same native
// index/text/transform; this does not rebind graphics by rectangle or source text.
export function matchNativeFigureRenderContext(
  snapshot,
  pageNumber,
  content,
  viewport,
  graphicsBounds,
  sourceSha256
) {
  try {
    if (
      !snapshot ||
      snapshot.pageNumber !== pageNumber ||
      snapshot.sourceSha256 !== sourceSha256 ||
      JSON.stringify(snapshot.viewport) !== JSON.stringify(nativeViewportValue(viewport)) ||
      JSON.stringify(snapshot.graphicsBounds) !== JSON.stringify(graphicsBounds) ||
      !Array.isArray(content?.items) ||
      snapshot.content.items.length !== content.items.length
    )
      return
    const forward = new Map(),
      backward = new Map()
    for (let index = 0; index < content.items.length; index++) {
      const old = snapshot.content.items[index],
        current = content.items[index]
      if (
        typeof old.str !== 'string' ||
        typeof current.str !== 'string' ||
        ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => old[k] !== current[k]) ||
        !finiteArray(old.transform, 6) ||
        !finiteArray(current.transform, 6) ||
        old.transform.some((n, i) => n !== current.transform[i]) ||
        !snapshot.content.styles[old.fontName] ||
        !content.styles?.[current.fontName] ||
        JSON.stringify(snapshot.content.styles[old.fontName]) !==
          JSON.stringify(content.styles[current.fontName]) ||
        (forward.has(old.fontName) && forward.get(old.fontName) !== current.fontName) ||
        (backward.has(current.fontName) && backward.get(current.fontName) !== old.fontName)
      )
        return
      forward.set(old.fontName, current.fontName)
      backward.set(current.fontName, old.fontName)
    }
    const result = {
      pageNumber,
      sourceSha256,
      operators: snapshot.operators,
      ...(snapshot.isolatedRasterScope
        ? { isolatedRasterScope: snapshot.isolatedRasterScope }
        : {}),
      ...(snapshot.dualApiEvidence ? { dualApiEvidence: snapshot.dualApiEvidence } : {}),
      ...(snapshot.glyphBounds ? { glyphBounds: snapshot.glyphBounds } : {}),
      ...(snapshot.foreignCompoundGlyphs
        ? { foreignCompoundGlyphs: snapshot.foreignCompoundGlyphs }
        : {}),
      ...(snapshot.captionLaneRaster ? { captionLaneRaster: snapshot.captionLaneRaster } : {}),
      ...(snapshot.filledGlyphEvidence
        ? { filledGlyphEvidence: snapshot.filledGlyphEvidence }
        : {}),
      ...(snapshot.partialFontGlyphBounds
        ? { partialFontGlyphBounds: snapshot.partialFontGlyphBounds }
        : {}),
      ...(snapshot.type3GlyphPrograms ? { type3GlyphPrograms: snapshot.type3GlyphPrograms } : {}),
      ...(snapshot.pixelType3Programs ? { pixelType3Programs: snapshot.pixelType3Programs } : {}),
      ...(snapshot.skippedSpaceGlyphs ? { skippedSpaceGlyphs: snapshot.skippedSpaceGlyphs } : {}),
      ...(snapshot.opaqueRasterImages ? { opaqueRasterImages: snapshot.opaqueRasterImages } : {}),
      ...(snapshot.compositingImages ? { compositingImages: snapshot.compositingImages } : {}),
      graphicsBounds: snapshot.graphicsBounds,
      viewport: {
        ...snapshot.viewport,
        convertToViewportPoint: (x, y) => {
          const point = [x, y]
          Util.applyTransform(point, snapshot.viewport.transform)
          return point
        }
      },
      content: {
        ...snapshot.content,
        items: snapshot.content.items.map((item, index) => ({
          ...item,
          sourceItem: { pageNumber, index, text: item.str }
        }))
      }
    }
    const mesh = nativeMesh4Snapshots.get(snapshot),
      keep = mesh && retainNativeRecoveryInputs([result], result.viewport)
    if (keep && mesh.current() && nativeMesh4PixelResourceData(mesh.handle, snapshot.operators))
      nativeMesh4Contexts.set(result, { ...mesh, keep, pageNumber, sourceSha256 })
    return result
  } catch {
    return
  }
}

// Preserve every earlier evidence allocation, including the caption raster's
// encoded bytes and temporary decoded pixels. This optional family is last.
export function bindNativeMesh4RenderContext(target, source) {
  try {
    const mesh = nativeMesh4Contexts.get(source),
      sourceValues = mesh && nativeRecoveryContextValues(source),
      targetValues = sourceValues && nativeRecoveryContextValues(target)
    if (
      !mesh ||
      !mesh.keep() ||
      !mesh.current() ||
      !targetValues ||
      Reflect.ownKeys(targetValues).length !== Reflect.ownKeys(sourceValues).length ||
      Reflect.ownKeys(sourceValues).some((key) => targetValues[key] !== sourceValues[key])
    )
      return target
    const keep = retainNativeRecoveryInputs([target], target.viewport)
    if (keep) nativeMesh4Contexts.set(target, { ...mesh, keep: () => mesh.keep() && keep() })
  } catch {
    /* Optional pixel evidence declines. */
  }
  return target
}

function nativeRecoveryContextValues(value) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key === 'symbol' || !Object.hasOwn(descriptors[key], 'value')
    )
  )
    return
  return Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value]))
}

export function nativeMesh4RenderContextData(context) {
  try {
    const mesh = nativeMesh4Contexts.get(context)
    return mesh &&
      mesh.keep() &&
      mesh.current() &&
      context.pageNumber === mesh.pageNumber &&
      context.sourceSha256 === mesh.sourceSha256
      ? nativeMesh4PixelResourceData(mesh.handle, context.operators)
      : undefined
  } catch {
    return
  }
}

// Seal only an exact completed render previously captured by this observer,
// before structure's normal cleanup releases its private resource stores.
export function sealNativeMesh4RenderContext(snapshot, renderTask) {
  try {
    const mesh = nativeMesh4Snapshots.get(snapshot)
    if (
      !mesh ||
      nativeSnapshotRenderTasks.get(snapshot)?.deref() !== renderTask ||
      !mesh.current() ||
      !nativeMesh4PixelResourceData(mesh.handle, snapshot.operators)
    )
      return false
    const task = renderTask._internalRenderTask,
      d = Object.getOwnPropertyDescriptors(task),
      fields = ['running', 'cancelled', 'graphicsReady', 'operatorListIdx', 'operatorList']
    if (
      fields.some((k) => !d[k] || !Object.hasOwn(d[k], 'value')) ||
      d.running.value !== false ||
      d.cancelled.value !== false ||
      d.graphicsReady.value !== true ||
      d.operatorListIdx.value !== snapshot.operators.fnArray.length
    )
      return false
    const last = Object.getOwnPropertyDescriptor(d.operatorList.value, 'lastChunk')
    if (!last || !Object.hasOwn(last, 'value') || last.value !== true) return false
    return sealNativeMesh4PixelResources(mesh.handle, renderTask, snapshot.operators)
  } catch {
    return false
  }
}

export function attachNativeCompositingResources(snapshot, renderTask, encodedCaptionBytes = 0) {
  try {
    if (nativeSnapshotRenderTasks.get(snapshot)?.deref() !== renderTask) return snapshot
    const retained = nativeSnapshotSize(snapshot, 16 * 1024 * 1024),
      raster = snapshot.captionLaneRaster
    if (
      retained === undefined ||
      (raster && (!Number.isSafeInteger(encodedCaptionBytes) || encodedCaptionBytes <= 0))
    )
      return snapshot
    const reserved = raster ? encodedCaptionBytes + raster.width * raster.height * 4 : 0,
      budget = 16 * 1024 * 1024 - retained - reserved,
      task = renderTask._internalRenderTask,
      o = snapshot.operators
    if (
      !(budget > 0) ||
      !o.fnArray.some(
        (op, i) => op === OPS.beginGroup && o.argsArray[i]?.[0]?.smask?.subtype === 'Alpha'
      )
    )
      return snapshot
    const images = []
    let bytes = 0
    for (let i = 0; i < o.fnArray.length; i++) {
      if (o.fnArray[i] !== OPS.paintImageXObject) continue
      const a = o.argsArray[i],
        store = a[0].startsWith('g_') ? task.commonObjs : task.objs,
        image = store.get(a[0])
      if (!image || types.isProxy(image) || Object.getPrototypeOf(image) !== Object.prototype)
        return snapshot
      const descriptors = Object.getOwnPropertyDescriptors(image)
      if (Reflect.ownKeys(descriptors).some((key) => !Object.hasOwn(descriptors[key], 'value')))
        return snapshot
      const kind = descriptors.kind?.value,
        width = descriptors.width?.value,
        height = descriptors.height?.value,
        data = descriptors.data?.value,
        view = nativeCompositingByteWindow(data)
      if (
        kind !== 3 ||
        !Number.isSafeInteger(width) ||
        width <= 0 ||
        !Number.isSafeInteger(height) ||
        height <= 0 ||
        width !== a[1] ||
        height !== a[2] ||
        ![Uint8Array.prototype, Uint8ClampedArray.prototype].includes(view?.prototype) ||
        view.length !== width * height * 4 ||
        view.length > 16_000_000
      )
        return snapshot
      bytes += view.byteLength + 1024
      if (bytes > budget) return snapshot
      images.push({
        operationIndex: i,
        imageId: a[0],
        width,
        height,
        kind,
        data: new Uint8Array(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
        sourceSha256: snapshot.sourceSha256
      })
    }
    if (!images.length || nativeSnapshotSize(images, budget) === undefined) return snapshot
    const value = { ...snapshot, compositingImages: images }
    nativeSnapshotRenderTasks.set(value, new WeakRef(renderTask))
    inheritNativeMesh4Snapshot(snapshot, value, reserved)
    return value
  } catch {
    return snapshot
  }
}

function nativeOpaqueRasterImages(operators, objects, budget) {
  if (typeof objects?.get !== 'function' || !(budget > 0)) return
  const result = []
  let bytes = 0
  for (let operationIndex = 0; operationIndex < operators.fnArray.length; operationIndex++) {
    if (operators.fnArray[operationIndex] !== OPS.paintImageXObject) continue
    const a = operators.argsArray[operationIndex]
    if (
      typeof a?.[0] !== 'string' ||
      !a[0] ||
      !Number.isSafeInteger(a[1]) ||
      a[1] <= 0 ||
      !Number.isSafeInteger(a[2]) ||
      a[2] <= 0
    )
      continue
    bytes += 256 + a[0].length * 2
    if (bytes > budget) return
    try {
      const image = objects.get(a[0]),
        length = a[1] * a[2] * 3
      if (
        image?.kind !== 2 ||
        image.bitmap ||
        image.width !== a[1] ||
        image.height !== a[2] ||
        !Number.isSafeInteger(length) ||
        !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) ||
        image.data.length !== length
      )
        continue
      result.push({ operationIndex, imageId: a[0], width: a[1], height: a[2], kind: 2 })
    } catch {
      // Missing decoded data declines only this optional image proof.
    }
  }
  return result
}

// Resolve each loaded font/character once, while the exact rendering page owns
// it. Retain numeric bounds only; unavailable/oversized evidence leaves legacy
// snapshots unchanged and the optional axis completion declines.
function nativeGlyphBounds(operators, objects, budget) {
  if (!objects || typeof objects.get !== 'function' || !(budget > 0)) return
  try {
    const fonts = new Map(),
      stack = []
    let active,
      bytes = 0
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i],
        a = operators.argsArray[i]
      if (op === OPS.setFont) active = a?.[0]
      else if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(active)
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!stack.length) return
        active = stack.pop()
      } else if (op === OPS.showText) {
        if (typeof active !== 'string' || !Array.isArray(a?.[0])) return
        let entry = fonts.get(active)
        if (!entry) {
          bytes += 256 + active.length * 2
          if (bytes > budget) return
          const font = objects.get(active)
          if (
            font?.loadedName !== active ||
            font.missingFile ||
            typeof font.getPathGenerator !== 'function'
          )
            return
          entry = { font, glyphs: new Map() }
          fonts.set(active, entry)
        }
        for (const glyph of a[0]) {
          if (typeof glyph === 'number') continue
          const character = glyph?.fontChar
          if (typeof character !== 'string' || !character) return
          if (entry.glyphs.has(character)) continue
          bytes += 256 + character.length * 2
          if (bytes > budget) return
          const bounds = entry.font.getPathGenerator(objects, character)?.getBounds?.()
          if (!finiteArray(bounds, 4) || bounds[0] > bounds[2] || bounds[1] > bounds[3]) return
          entry.glyphs.set(character, Array.from(bounds))
        }
      }
    }
    if (stack.length) return
    return [...fonts].map(([fontName, entry]) => ({
      fontName,
      glyphs: [...entry.glyphs].map(([fontChar, bounds]) => ({ fontChar, bounds }))
    }))
  } catch {
    return
  }
}

function nativeForeignCompoundGlyphs(operators, objects, budget) {
  if (typeof objects?.get !== 'function' || !(budget > 0)) return
  try {
    const fonts = new Map(),
      stack = []
    let active,
      bytes = 0
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i],
        a = operators.argsArray[i]
      if (op === OPS.setFont) active = a?.[0]
      else if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op))
        stack.push(active)
      else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
        if (!stack.length) return
        active = stack.pop()
      } else if (op === OPS.showText)
        for (const g of a?.[0] ?? []) {
          if (typeof g !== 'object' || g?.accent == null) continue
          const accent = g.accent,
            character = accent?.fontChar
          if (
            g.isInFont !== true ||
            g.isSpace === true ||
            !/\S/u.test(g.unicode ?? '') ||
            typeof active !== 'string' ||
            typeof character !== 'string' ||
            !character ||
            !Number.isFinite(accent.offset?.x) ||
            !Number.isFinite(accent.offset?.y)
          )
            return
          let entry = fonts.get(active)
          if (!entry) {
            bytes += 512 + active.length * 2
            if (bytes > budget || fonts.size >= 64) return
            const font = objects.get(active)
            if (
              font?.loadedName !== active ||
              font.missingFile ||
              font.disableFontFace !== true ||
              font.remeasure ||
              font.isType3Font ||
              typeof font.getPathGenerator !== 'function' ||
              JSON.stringify(Array.from(font.fontMatrix ?? [])) !==
                JSON.stringify([0.001, 0, 0, 0.001, 0, 0])
            )
              return
            entry = { font, glyphs: new Map() }
            fonts.set(active, entry)
          }
          if (entry.glyphs.has(character)) continue
          bytes += 512 + character.length * 2
          if (bytes > budget) return
          const bounds = entry.font.getPathGenerator(objects, character)?.getBounds?.()
          if (!finiteArray(bounds, 4) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return
          entry.glyphs.set(character, Array.from(bounds))
        }
    }
    if (stack.length) return
    const result = [...fonts].map(([fontName, entry]) => ({
      fontName,
      missingFile: false,
      disableFontFace: true,
      remeasure: false,
      isType3Font: false,
      fontMatrix: Array.from(entry.font.fontMatrix),
      glyphs: [...entry.glyphs].map(([fontChar, bounds]) => ({ fontChar, bounds }))
    }))
    return nativeSnapshotSize(result, budget) === undefined ? undefined : result
  } catch {
    return
  }
}

// CanvasGraphics.showText skips a glyph outside an ordinary loaded font, even
// when its .notdef outline is nonempty. The invalid-font and Type3 branches
// bypass that guard. Bind only whitespace to its exact show/glyph occurrence;
// another occurrence of the same fontChar can still paint the real outline.
function nativeSkippedSpaceGlyphs(operators, objects, budget) {
  if (!objects || typeof objects.get !== 'function' || !(budget > 0)) return
  try {
    const result = [],
      stack = []
    let active,
      bytes = 0
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i],
        args = operators.argsArray[i]
      if (op === OPS.setFont) active = args?.[0]
      else if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(active)
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!stack.length) return
        active = stack.pop()
      } else if (op === OPS.showText) {
        if (typeof active !== 'string' || !Array.isArray(args?.[0])) return
        for (const [glyphIndex, glyph] of args[0].entries()) {
          if (
            typeof glyph?.unicode !== 'string' ||
            !/^\s+$/u.test(glyph.unicode) ||
            (glyph.isSpace !== true && glyph.isSpace !== false) ||
            glyph.isInFont !== false ||
            typeof glyph.fontChar !== 'string' ||
            !glyph.fontChar ||
            !Number.isFinite(glyph.width) ||
            glyph.width < 0 ||
            glyph.accent != null ||
            glyph.operatorListId != null ||
            glyph.vmetric != null
          )
            continue
          const font = objects.get(active)
          if (
            font?.loadedName !== active ||
            font.missingFile !== false ||
            font.isInvalidPDFjsFont !== false ||
            font.isType3Font !== false ||
            typeof font.getPathGenerator !== 'function'
          )
            continue
          result.push({
            operationIndex: i,
            glyphIndex,
            fontName: active,
            fontChar: glyph.fontChar,
            width: glyph.width,
            ...(glyph.unicode !== ' ' ? { unicode: glyph.unicode } : {}),
            // CanvasGraphics skips an absent glyph in a loaded ordinary font
            // independently of word-spacing classification. Bind that flag;
            // legacy ordinary-space certificates retain their exact shape.
            ...(glyph.isSpace === false ? { isSpace: false } : {})
          })
          bytes += 256 + (active.length + glyph.fontChar.length) * 2
          if (bytes > budget) return
        }
      }
    }
    return stack.length || nativeSnapshotSize(result, budget) === undefined ? undefined : result
  } catch {
    return
  }
}

// Every returned font is complete for its whole original showText inventory.
// Missing fonts are omitted atomically; only an explicitly partial-aware
// consumer may use this evidence. Reuse the strict path collector per font.
function nativePartialFontGlyphBounds(operators, objects, budget) {
  if (!objects || typeof objects.get !== 'function' || !(budget > 0)) return
  try {
    const runs = new Map(),
      stack = []
    let active
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i],
        args = operators.argsArray[i]
      if (op === OPS.setFont) active = args?.[0]
      else if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(active)
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!stack.length) return
        active = stack.pop()
      } else if (op === OPS.showText) {
        if (typeof active !== 'string' || !Array.isArray(args?.[0])) return
        if (!runs.has(active)) runs.set(active, [])
        runs.get(active).push(args)
      }
    }
    if (stack.length) return
    const result = []
    let bytes = 0
    for (const [fontName, args] of runs) {
      const proof = nativeGlyphBounds(
        {
          fnArray: [OPS.setFont, ...args.map(() => OPS.showText)],
          argsArray: [[fontName, 1], ...args]
        },
        objects,
        budget - bytes
      )
      if (!proof?.length) continue
      for (const font of proof) {
        bytes +=
          256 +
          font.fontName.length * 2 +
          font.glyphs.reduce((n, glyph) => n + 256 + glyph.fontChar.length * 2, 0)
        if (bytes > budget) return
        result.push(font)
      }
    }
    return result.length ? result : undefined
  } catch {
    return
  }
}

// A Type3 font paints a charproc, not the ordinary fontChar outline. Retain only
// a complete used-program inventory of native filled paths with their own clip.
// This separate optional field never substitutes for all-font glyphBounds.
function nativeType3GlyphPrograms(operators, objects, content, budget) {
  if (!objects || typeof objects.get !== 'function' || !(budget > 0)) return
  try {
    const fonts = new Map(),
      unicodeOwners = new Map(),
      stack = [],
      finite = (a, n) =>
        (Array.isArray(a) || ArrayBuffer.isView(a)) &&
        a.length === n &&
        Array.from(a).every(Number.isFinite),
      same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
    let active,
      bytes = 0
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i],
        args = operators.argsArray[i]
      if (op === OPS.setFont) active = args?.[0]
      else if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(active)
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!stack.length) return
        active = stack.pop()
      } else if (op === OPS.showText) {
        if (typeof active !== 'string' || !Array.isArray(args?.[0])) return
        const font = objects.get(active)
        if (font?.loadedName !== active || typeof font.isType3Font !== 'boolean') return
        if (!font.isType3Font) continue
        let entry = fonts.get(active)
        if (!entry) {
          const matrix = font.fontMatrix,
            sourceIndices = content.items.flatMap((r, index) =>
              r.fontName === active && typeof r.str === 'string' && r.str.length ? [index] : []
            )
          if (
            font.missingFile !== false ||
            font.isInvalidPDFjsFont !== false ||
            (font.vertical !== undefined && font.vertical !== false) ||
            (font.remeasure !== undefined && font.remeasure !== false) ||
            !finite(matrix, 6) ||
            matrix[0] <= 0 ||
            matrix[3] <= 0 ||
            [1, 2, 4, 5].some((n) => matrix[n] !== 0) ||
            !content.styles?.[active] ||
            (content.styles[active].vertical !== undefined &&
              content.styles[active].vertical !== false) ||
            !sourceIndices.length
          )
            return
          entry = {
            fontName: active,
            fontMatrix: Array.from(matrix),
            sourceIndices,
            glyphs: new Map()
          }
          fonts.set(active, entry)
          unicodeOwners.set(active, new Map())
          bytes += 512 + active.length * 2 + sourceIndices.length * 8
        }
        for (const [glyphIndex, g] of args[0].entries()) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) return
            continue
          }
          if (
            g?.fontChar !== '' ||
            typeof g.operatorListId !== 'string' ||
            !g.operatorListId.length ||
            g.operatorListId.length > 256 ||
            typeof g.unicode !== 'string' ||
            Array.from(g.unicode).length !== 1 ||
            !Number.isFinite(g.width) ||
            g.width <= 0 ||
            g.isInFont !== true ||
            g.accent != null ||
            g.vmetric != null
          )
            return
          const owner = unicodeOwners.get(active),
            previous = entry.glyphs.get(g.operatorListId)
          if (
            (owner.has(g.unicode) && owner.get(g.unicode) !== g.operatorListId) ||
            (previous && (previous.unicode !== g.unicode || previous.width !== g.width))
          )
            return
          let proof = previous
          if (!proof) {
            const program = font.charProcOperatorList?.[g.operatorListId]
            if (
              !Array.isArray(program?.fnArray) ||
              !Array.isArray(program.argsArray) ||
              program.fnArray.length !== program.argsArray.length
            )
              return
            const empty = g.unicode === ' ' && g.isSpace === true,
              n = empty ? 0 : 1
            if (
              program.fnArray.length !== n + 1 ||
              program.fnArray[n] !== OPS.constructPath ||
              (!empty && (g.isSpace !== false || program.fnArray[0] !== OPS.setCharWidthAndBounds))
            )
              return
            const paint = program.argsArray[n]
            if (
              !Array.isArray(paint) ||
              paint.length !== 3 ||
              ![OPS.fill, OPS.eoFill].includes(paint[0]) ||
              !Array.isArray(paint[1]) ||
              paint[1].length !== 1 ||
              !(paint[1][0] instanceof Path2D)
            )
              return
            const bounds = Array.from(paint[1][0].getBounds()),
              tight = Array.from(paint[1][0].computeTightBounds())
            if (!finite(bounds, 4) || !finite(tight, 4) || !same(bounds, tight)) return
            let clip = null
            if (empty) {
              if (paint[2] !== null || bounds.some((v) => v !== 0)) return
            } else {
              const widthAndBounds = program.argsArray[0]
              if (
                !finite(widthAndBounds, 6) ||
                widthAndBounds[0] !== g.width ||
                widthAndBounds[1] !== 0 ||
                !(bounds[2] > bounds[0] && bounds[3] > bounds[1]) ||
                !finite(paint[2], 4)
              )
                return
              clip = Array.from(widthAndBounds).slice(2)
              if (!same(clip, bounds) || !same(Array.from(paint[2]), bounds)) return
            }
            proof = {
              operatorListId: g.operatorListId,
              unicode: g.unicode,
              width: g.width,
              kind: empty ? 'empty-space' : 'filled-path',
              bounds,
              clip,
              paint: paint[0],
              occurrences: []
            }
            entry.glyphs.set(g.operatorListId, proof)
            owner.set(g.unicode, g.operatorListId)
            bytes += 512 + (g.operatorListId.length + g.unicode.length) * 2
          }
          proof.occurrences.push({ operationIndex: i, glyphIndex })
          bytes += 128
          if (bytes > budget) return
        }
      }
    }
    if (stack.length || !fonts.size) return
    const result = [...fonts.values()].map((f) => ({ ...f, glyphs: [...f.glyphs.values()] }))
    return nativeSnapshotSize(result, budget) === undefined ? undefined : result
  } catch {
    return
  }
}

// Both API values come from the exact page/render task. Clone API containers just
// like captureNativeFigureRenderContext: PDF.js styles have a null prototype.
// Keep a separate immutable-value render snapshot so later caller mutations cannot
// silently alter their evidence. The existing combined 16 MiB budget remains fixed.
export function attachNativeDualApiEvidence(snapshot, defaultContent, rawContent) {
  try {
    const budget = 16 * 1024 * 1024,
      bytes = [snapshot, defaultContent, rawContent].map((v) => nativeSnapshotSize(v, budget))
    if (bytes.some((n) => n === undefined) || bytes[0] * 2 + bytes[1] + bytes[2] + 1024 > budget)
      return snapshot
    const evidence = {
      schema: 'same-pdfjs-page-dual-api-capture-v1',
      apiDefaultOptions: {},
      apiRawOptions: { disableNormalization: true },
      defaultContent: structuredClone(defaultContent),
      rawContent: structuredClone(rawContent),
      renderContext: structuredClone(snapshot),
      sourceSha256: snapshot.sourceSha256,
      pageNumber: snapshot.pageNumber,
      pdfjsVersion: version
    }
    if (
      !verifyNativeDualApiCertificate(
        { pageNumber: snapshot.pageNumber, graphicsBounds: snapshot.graphicsBounds },
        snapshot,
        evidence
      ) &&
      !verifyNativeLigatureApiCertificate(
        { pageNumber: snapshot.pageNumber, graphicsBounds: snapshot.graphicsBounds },
        snapshot,
        evidence
      )
    )
      return snapshot
    const result = { ...snapshot, dualApiEvidence: evidence }
    if (nativeSnapshotRenderTasks.has(snapshot))
      nativeSnapshotRenderTasks.set(result, nativeSnapshotRenderTasks.get(snapshot))
    inheritNativeMesh4Snapshot(snapshot, result)
    return nativeSnapshotSize(result, budget) === undefined ? snapshot : result
  } catch {
    return snapshot
  }
}

// Capture is requested by actual operator Unicode, not a guessed source-word
// substitution. Attaching evidence still applies the existing combined budget.
export function nativeLigatureDualApiCaptureRequired(snapshot) {
  return (
    snapshot?.operators?.fnArray?.some(
      (op, i) =>
        op === OPS.showText &&
        snapshot.operators.argsArray[i]?.[0]?.some(
          (g) => g && typeof g === 'object' && ['ﬁ', 'ﬂ'].includes(g.unicode)
        )
    ) === true
  )
}

// Geometry-only observations precede the renderer replacing path commands by
// opaque Path2D values. The full original raw-path observer above is unchanged.
function observeNativeGroupPaintMetadata(renderTask, operators) {
  let state = nativeGroupPaintMetadata.get(renderTask)
  if (!state) {
    const viewport = renderTask?._internalRenderTask?.params?.viewport
    const slots = [],
      metadata = []
    const params = renderTask._internalRenderTask.params,
      transform = Object.getOwnPropertyDescriptor(params, 'transform'),
      viewportCurrent = retainNativeRecoveryInputs([viewport], viewport),
      fnPrototype = Object.getPrototypeOf(operators.fnArray),
      argsPrototype = Object.getPrototypeOf(operators.argsArray)
    const sameTransform = () => {
      const d = Object.getOwnPropertyDescriptor(params, 'transform')
      return transform
        ? !!d &&
            Object.hasOwn(d, 'value') &&
            Object.is(d.value, transform.value) &&
            d.writable === transform.writable &&
            d.enumerable === transform.enumerable &&
            d.configurable === transform.configurable
        : !d
    }
    state = {
      operators,
      viewport,
      slots,
      metadata,
      invalid: false,
      current: () => {
        if (
          !viewportCurrent ||
          !viewportCurrent() ||
          !sameTransform() ||
          renderTask._internalRenderTask.params !== params ||
          Object.getPrototypeOf(operators.fnArray) !== fnPrototype ||
          Object.getPrototypeOf(operators.argsArray) !== argsPrototype ||
          Reflect.ownKeys(operators.fnArray).length !== slots.length + 1 ||
          Reflect.ownKeys(operators.argsArray).length !== slots.length + 1 ||
          state.invalid ||
          renderTask._internalRenderTask.operatorList !== operators ||
          renderTask._internalRenderTask.params?.viewport !== viewport ||
          operators.fnArray !== state.fnArray ||
          operators.argsArray !== state.argsArray ||
          operators.fnArray.length !== slots.length ||
          operators.argsArray.length !== slots.length
        )
          return false
        for (let i = 0; i < slots.length; i++) {
          const f = Object.getOwnPropertyDescriptor(operators.fnArray, String(i)),
            a = Object.getOwnPropertyDescriptor(operators.argsArray, String(i)),
            s = slots[i]
          if (
            !f ||
            !a ||
            !Object.hasOwn(f, 'value') ||
            !Object.hasOwn(a, 'value') ||
            f.value !== s.op ||
            a.value !== s.args ||
            f.enumerable !== s.fd.enumerable ||
            f.configurable !== s.fd.configurable ||
            f.writable !== s.fd.writable ||
            a.enumerable !== s.ad.enumerable ||
            a.configurable !== s.ad.configurable ||
            a.writable !== s.ad.writable
          )
            return false
        }
        return state.checks?.every((check) => check()) ?? true
      }
    }
    state.fnArray = operators.fnArray
    state.argsArray = operators.argsArray
    nativeGroupPaintMetadata.set(renderTask, state)
  }
  if (
    state.invalid ||
    operators.fnArray !== state.fnArray ||
    operators.argsArray !== state.argsArray ||
    operators.fnArray.length > 100000 ||
    operators.fnArray.length !== operators.argsArray.length
  ) {
    state.invalid = true
    return
  }
  const scoped = new Set([
    OPS.save,
    OPS.restore,
    OPS.transform,
    OPS.paintFormXObjectBegin,
    OPS.paintFormXObjectEnd,
    OPS.beginGroup,
    OPS.endGroup,
    OPS.beginText,
    OPS.endText
  ])
  for (let i = state.slots.length; i < operators.fnArray.length; i++) {
    const fd = Object.getOwnPropertyDescriptor(operators.fnArray, String(i)),
      ad = Object.getOwnPropertyDescriptor(operators.argsArray, String(i))
    if (!fd || !ad || !Object.hasOwn(fd, 'value') || !Object.hasOwn(ad, 'value')) {
      state.invalid = true
      return
    }
    const op = fd.value,
      args = ad.value
    state.slots.push({ op, args, fd, ad })
    if (scoped.has(op)) {
      state.metadata.push(args)
      if (args && typeof args === 'object') {
        const current = retainNativeRecoveryInputs([args])
        if (!current) {
          state.invalid = true
          return
        }
        state.checks ??= []
        state.checks.push(current)
      }
    }
  }
}

// Keep the old all-paint geometry allocation in every later snapshot/font
// budget. This private binding changes accounting only, never visible bounds.
export function bindNativeGroupPaintBudget(renderTask, coarse, visible) {
  const observation = nativeGroupPaintMetadata.get(renderTask)
  if (!observation || !observation.current()) return false
  const retained = retainNativeRecoveryInputs([coarse])
  if (!retained) return false
  nativeGraphicsBudgetBasis.set(visible, {
    coarse,
    current: () => observation.current() && retained()
  })
  return true
}

// The tracker keeps conservative operation boxes inside a temporary group
// canvas. Its complete renderer-enforced BBox also clips those paints when
// that canvas is composited back onto the page. Keep every original operation;
// this optional geometry envelope grants no text or Source ownership.
export function nativeRecordedGroupPaintEnvelopes(renderTask) {
  const observed = nativeGroupPaintMetadata.get(renderTask),
    task = renderTask?._internalRenderTask,
    operators = task?.operatorList,
    viewport = task?.params?.viewport
  if (!Array.isArray(operators?.fnArray) || !operators.fnArray.includes(OPS.beginGroup)) return
  if (
    !observed ||
    observed.operators !== operators ||
    observed.viewport !== viewport ||
    !observed.current()
  )
    return
  const transformDescriptor = Object.getOwnPropertyDescriptor(task.params, 'transform')
  if (transformDescriptor && !Object.hasOwn(transformDescriptor, 'value')) return
  const renderTransform = transformDescriptor?.value
  try {
    if (!operators.fnArray.includes(OPS.beginGroup) || renderTransform != null) return
    const retained = retainNativeRecoveryInputs([observed.metadata, viewport], viewport)
    const current = () => !!retained && retained() && observed.current()
    const finite = (a, n) =>
      (Array.isArray(a) || ArrayBuffer.isView(a)) &&
      a.length === n &&
      (!Array.isArray(a) || Reflect.ownKeys(a).length === n + 1) &&
      Array.from(a).every(Number.isFinite)
    const rect = (a) => finite(a, 4) && a[0] < a[2] && a[1] < a[3]
    if (
      !current ||
      !Array.isArray(operators.argsArray) ||
      operators.fnArray.length !== operators.argsArray.length ||
      operators.fnArray.length > 100000 ||
      !finite(viewport.transform, 6) ||
      !Number.isFinite(viewport.width) ||
      !(viewport.width > 0) ||
      !Number.isFinite(viewport.height) ||
      !(viewport.height > 0)
    )
      return
    const project = (r, ctm) => {
      const m = Util.transform(viewport.transform, ctm)
      const points = [
        [r[0], r[1]],
        [r[2], r[1]],
        [r[2], r[3]],
        [r[0], r[3]]
      ]
      for (const p of points) Util.applyTransform(p, m)
      return [
        Math.min(...points.map((p) => p[0])),
        Math.min(...points.map((p) => p[1])),
        Math.max(...points.map((p) => p[0])),
        Math.max(...points.map((p) => p[1]))
      ]
    }
    const hit = (a, b) => [
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
      Math.min(a[2], b[2]),
      Math.min(a[3], b[3])
    ]
    const knownGroup = (a) =>
      Array.isArray(a) &&
      a.length === 1 &&
      Reflect.ownKeys(a).join(',') === '0,length' &&
      a[0] &&
      Reflect.ownKeys(a[0]).every((k) => typeof k === 'string') &&
      Reflect.ownKeys(a[0]).sort().join(',') === 'bbox,isolated,knockout,matrix,smask' &&
      a[0].matrix === null &&
      a[0].smask === null &&
      a[0].knockout === false &&
      typeof a[0].isolated === 'boolean' &&
      Array.isArray(a[0].bbox) &&
      rect(a[0].bbox)
    const clips = new Map(),
      stack = [],
      known = new Set(Object.values(OPS))
    let ctm = [1, 0, 0, 1, 0, 0],
      clip = [0, 0, viewport.width, viewport.height],
      groups = 0,
      text = false
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i],
        a = operators.argsArray[i]
      if (!known.has(op) || [OPS.beginAnnotation, OPS.endAnnotation].includes(op)) return
      if (op === OPS.beginText) {
        if (text) return
        text = true
      } else if (op === OPS.endText) {
        if (!text) return
        text = false
      }
      if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) {
        if (text || stack.length >= 512) return
        const old = { op, ctm: [...ctm], clip: [...clip], groups, group: undefined }
        stack.push(old)
        if (op === OPS.paintFormXObjectBegin) {
          if (
            !Array.isArray(a) ||
            a.length !== 2 ||
            (a[0] !== null && !finite(a[0], 6)) ||
            (a[1] !== null && !rect(a[1]))
          )
            return
          if (a[0] !== null) ctm = Util.transform(ctm, a[0])
          if (a[1] !== null) clip = hit(clip, project(a[1], ctm))
        } else if (op === OPS.beginGroup) {
          if (!knownGroup(a)) return
          old.group = a[0]
          clip = hit(clip, project(a[0].bbox, ctm))
          groups++
        }
      } else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
        const old = stack.pop(),
          expected =
            op === OPS.restore
              ? OPS.save
              : op === OPS.paintFormXObjectEnd
                ? OPS.paintFormXObjectBegin
                : OPS.beginGroup
        if (text || !old || old.op !== expected) return
        if (
          op === OPS.endGroup &&
          (!knownGroup(a) || JSON.stringify(a[0]) !== JSON.stringify(old.group))
        )
          return
        ctm = old.ctm
        clip = old.clip
        groups = old.groups
      } else if (op === OPS.transform) {
        if (!finite(a, 6)) return
        ctm = Util.transform(ctm, a)
      }
      if (!ctm.every(Number.isFinite) || !clip.every(Number.isFinite)) return
      if (
        groups &&
        [
          OPS.constructPath,
          OPS.paintImageXObject,
          OPS.paintImageXObjectRepeat,
          OPS.paintInlineImageXObject,
          OPS.paintInlineImageXObjectGroup,
          OPS.paintImageMaskXObject,
          OPS.paintImageMaskXObjectGroup,
          OPS.paintImageMaskXObjectRepeat
        ].includes(op)
      )
        clips.set(
          i,
          clip.map((v, n) => v / (n % 2 ? viewport.height : viewport.width))
        )
    }
    if (stack.length || groups || text || !current()) return
    return { clips, current }
  } catch {
    return
  }
}

// Apply the same native snapshot byte accounting to optional live pixel inputs.
// This grants no render, glyph, Source or crop authority.
export function nativeAdditionalPixelInputsFit(context, ...inputs) {
  try {
    const values = nativeRecoveryBudgetValues(context)
    if (values === undefined || inputs.length !== 2) return false
    const current = retainNativeRecoveryInputs([values, ...inputs])
    if (!current) return false
    const budget = 16 * 1024 * 1024,
      bytes = [values, ...inputs].map((v) => nativeSnapshotSize(v, budget))
    return (
      current() &&
      !bytes.some((n) => n === undefined) &&
      bytes[0] * 2 + bytes[1] + bytes[2] + 1024 <= budget
    )
  } catch {
    return false
  }
}
function nativeRecoveryBudgetValues(context) {
  if (!context || types.isProxy(context)) return
  const descriptors = Object.getOwnPropertyDescriptors(context)
  if (Reflect.ownKeys(descriptors).some((k) => !Object.hasOwn(descriptors[k], 'value'))) return
  const viewport = context.viewport
  if (!viewport || types.isProxy(viewport)) return
  const vd = Object.getOwnPropertyDescriptors(viewport)
  if (Reflect.ownKeys(vd).some((k) => !Object.hasOwn(vd[k], 'value'))) return
  const value = { ...context, viewport: { ...viewport } }
  delete value.viewport.convertToViewportPoint
  return value
}
