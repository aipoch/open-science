/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { OPS, Util, version } from 'pdfjs-dist/legacy/build/pdf.mjs'

const nativeRenderPaths = new WeakMap()

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
  const state = { paths: new Map(), bytes: 0, buffers: new Set(), overflow: false, scanned: 0 }
  nativeRenderPaths.set(renderTask, state)
  const previousContinue = renderTask.onContinue
  renderTask.onContinue = (resume) => {
    // The public continuation callback precedes each execution chunk, including
    // clip-only paths whose execution does not call the painted-box tracker.
    if (operators.fnArray.length > 100000) {
      state.overflow = true
      state.paths.clear()
      state.buffers.clear()
    }
    for (; !state.overflow && state.scanned < operators.fnArray.length; state.scanned++) {
      const index = state.scanned
      if (operators.fnArray[index] === OPS.constructPath) {
        const args = operators.argsArray[index],
          path = args?.[1]?.[0]
        if (ArrayBuffer.isView(path) || Array.isArray(path) || path == null) {
          state.bytes += 128 + (Array.isArray(path) ? path.length * 8 : 0)
          if (ArrayBuffer.isView(path) && !state.buffers.has(path.buffer)) {
            state.buffers.add(path.buffer)
            state.bytes += path.buffer.byteLength
          }
          if (state.bytes > 16 * 1024 * 1024) {
            state.overflow = true
            state.paths.clear()
            state.buffers.clear()
          } else state.paths.set(index, [args[0], [path], args[2]])
        }
      }
    }
    if (previousContinue) previousContinue.call(renderTask, resume)
    else resume()
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
    const pending = [value],
      seen = new Set()
    let size = 0
    while (pending.length) {
      const item = pending.pop()
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
      if (size > 16 * 1024 * 1024) return
    }
    const snapshot = structuredClone(value)
    const glyphBounds = nativeGlyphBounds(operators, commonObjs, 16 * 1024 * 1024 - size)
    if (glyphBounds) snapshot.glyphBounds = glyphBounds
    // This records decoded RGB shape only, never copies pixels or infers alpha
    // from a thumbnail. Consumers must separately prove graphics state and clip.
    const glyphBytes =
      glyphBounds?.reduce(
        (sum, f) =>
          sum +
          256 +
          f.fontName.length * 2 +
          f.glyphs.reduce((n, g) => n + 256 + g.fontChar.length * 2, 0),
        0
      ) ?? 0
    const opaqueRasterImages = nativeOpaqueRasterImages(
      operators,
      task.objs,
      16 * 1024 * 1024 - size - glyphBytes
    )
    if (opaqueRasterImages?.length) snapshot.opaqueRasterImages = opaqueRasterImages
    return snapshot
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
    return {
      operators: snapshot.operators,
      ...(snapshot.glyphBounds ? { glyphBounds: snapshot.glyphBounds } : {}),
      ...(snapshot.opaqueRasterImages ? { opaqueRasterImages: snapshot.opaqueRasterImages } : {}),
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
  } catch {
    return
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
