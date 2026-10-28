/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'

const proofs = new WeakMap(),
  digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const valid = (r) =>
  (Array.isArray(r) || ArrayBuffer.isView(r)) &&
  r.length === 4 &&
  Array.from(r).every(Number.isFinite) &&
  r[0] < r[2] &&
  r[1] < r[3]
const inside = (outer, inner) =>
  valid(outer) &&
  valid(inner) &&
  Array.from(inner).every((v, i) => (i < 2 ? v >= outer[i] : v <= outer[i]))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const finite = (values, length) =>
  Array.isArray(values) && values.length === length && values.every(Number.isFinite)
const MAX_IMAGE_BYTES = 64 * 1024 * 1024,
  MAX_PAGE_BYTES = 256 * 1024 * 1024,
  MAX_IMAGES = 8,
  CHUNK = 65536
const imageHash = (image, data) => {
  const hash = createHash('sha256').update(`${image.width}:${image.height}:${image.kind}:`)
  for (let at = 0; at < data.byteLength; at += CHUNK)
    hash.update(data.subarray(at, Math.min(data.byteLength, at + CHUNK)))
  return hash.digest('hex')
}

// No decoded pixels enter the snapshot. This optional proof is created only
// while its exact completed native render and observed paths are available.
export function captureNativeIsolatedRasterScope(snapshot, renderTask, observedPaths) {
  try {
    const task = renderTask?._internalRenderTask,
      o = snapshot?.operators,
      v = snapshot?.viewport,
      rendered = task?.params?.viewport
    if (
      !/^[a-f0-9]{64}$/u.test(snapshot?.sourceSha256 ?? '') ||
      !Number.isSafeInteger(snapshot?.pageNumber) ||
      snapshot.pageNumber < 1 ||
      !observedPaths ||
      observedPaths.overflow ||
      observedPaths.scanned !== o?.fnArray?.length ||
      !task ||
      task.params?.transform ||
      task.operatorList.fnArray.length !== o.fnArray.length ||
      !same(task.operatorList.fnArray, o.fnArray) ||
      !snapshot.glyphBounds ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      !Number.isFinite(v.width) ||
      v.width <= 0 ||
      !Number.isFinite(v.height) ||
      v.height <= 0 ||
      !finite(v.transform, 6) ||
      !Number.isFinite(rendered?.scale) ||
      rendered.scale <= 0 ||
      rendered.rotation !== v.rotation ||
      !Number.isFinite(rendered.width) ||
      !Number.isFinite(rendered.height) ||
      !finite(rendered.transform, 6) ||
      Math.abs(rendered.width - v.width * rendered.scale) > 1e-7 ||
      Math.abs(rendered.height - v.height * rendered.scale) > 1e-7 ||
      rendered.transform.some(
        (value, index) => Math.abs(value - v.transform[index] * rendered.scale) > 1e-7
      ) ||
      o.fnArray.length > 100000
    )
      return
    if (
      digest(o.argsArray) !==
      digest(
        task.operatorList.argsArray.map((args, index) => observedPaths.paths.get(index) ?? args)
      )
    )
      return
    const e = {
      images: [],
      paths: new Map(),
      texts: new Map(),
      frames: new Map(),
      isolatedGroups: new Map()
    }
    collectClosedFigureFrames(o, v, e)
    if (e.invalidIsolatedGroups || e.isolatedGroups.size !== 1) return
    const [[begin, group]] = [...e.isolatedGroups],
      end = group.end
    if (!Number.isSafeInteger(end) || !valid(group.rect) || !same(group.rect, group.clip)) return
    const forms = [],
      stack = [],
      ordinaryOperations = new Set(),
      images = []
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.paintFormXObjectBegin) {
        if (
          i <= begin ||
          i >= end ||
          a?.length !== 2 ||
          a[0] !== null ||
          stack.length > 1 ||
          forms.length >= 9
        )
          return
        if (stack.length === 0) {
          if (forms.length || i !== begin + 1 || a[1] !== null) return
        } else if (!valid(a[1])) return
        const form = {
          begin: i,
          parent: stack.at(-1)?.begin ?? null,
          bbox: a[1] === null ? null : Array.from(a[1])
        }
        forms.push(form)
        stack.push(form)
      } else if (op === OPS.paintFormXObjectEnd) {
        const form = stack.pop()
        if (!form || i >= end) return
        form.end = i
      } else if (op === OPS.setGState) {
        if (
          !Array.isArray(a?.[0]) ||
          a[0].some(
            (entry) =>
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              !(
                (['CA', 'ca'].includes(entry[0]) &&
                  Number.isFinite(entry[1]) &&
                  entry[1] >= 0 &&
                  entry[1] <= 1) ||
                (entry[0] === 'SMask' && entry[1] === false) ||
                (entry[0] === 'BM' && entry[1] === 'source-over' && i > begin && i < end)
              )
          )
        )
          return
        if (a[0].some((entry) => entry[0] === 'BM')) ordinaryOperations.add(i)
      } else if ([OPS.setFillColorN, OPS.setStrokeColorN, OPS.shadingFill].includes(op)) return
      else if (op === OPS.showText && i > begin && i < end) return
      else if (op === OPS.paintImageXObject) {
        if (
          i <= begin ||
          i >= end ||
          images.length >= MAX_IMAGES ||
          a?.length !== 3 ||
          typeof a[0] !== 'string' ||
          !Number.isSafeInteger(a[1]) ||
          !Number.isSafeInteger(a[2]) ||
          a[1] <= 0 ||
          a[2] <= 0
        )
          return
        const store = a[0].startsWith('g_') ? task.commonObjs : task.objs,
          image = store?.get(a[0]),
          data = image?.data
        if (
          !image ||
          image.bitmap ||
          ![2, 3].includes(image.kind) ||
          image.width !== a[1] ||
          image.height !== a[2] ||
          ![Uint8Array.prototype, Uint8ClampedArray.prototype].includes(
            Object.getPrototypeOf(data ?? {})
          )
        )
          return
        const bytes = image.width * image.height * (image.kind === 3 ? 4 : 3)
        if (
          !Number.isSafeInteger(bytes) ||
          bytes <= 0 ||
          bytes > MAX_IMAGE_BYTES ||
          data.byteLength !== bytes
        )
          return
        images.push({ operationIndex: i, imageId: a[0], image, data, bytes })
      } else if (
        [
          OPS.paintImageMaskXObject,
          OPS.paintImageMaskXObjectGroup,
          OPS.paintImageMaskXObjectRepeat,
          OPS.paintImageXObjectRepeat,
          OPS.paintInlineImageXObject,
          OPS.paintInlineImageXObjectGroup
        ].includes(op)
      )
        return
    }
    if (
      stack.length ||
      !forms.length ||
      forms[0].end !== end - 1 ||
      !images.length ||
      images.reduce((n, r) => n + r.bytes, 0) > MAX_PAGE_BYTES
    )
      return
    if (e.images.length !== images.length || e.images.some((im) => !inside(group.clip, im.rect)))
      return
    const imageViews = []
    // Preflight every view and the aggregate bound above before any hash scan.
    for (const row of images) {
      if (!same(o.argsArray[row.operationIndex], task.operatorList.argsArray[row.operationIndex]))
        return
      const actual = snapshot.graphicsBounds.filter(
        (g) => g.kind === 'image' && g.operationIndex === row.operationIndex
      )
      if (actual.length !== 1) return
      const rect = e.images.find((im) => im.operationIndex === row.operationIndex)?.rect
      if (!inside(group.clip, rect)) return
      imageViews.push({
        operationIndex: row.operationIndex,
        imageId: row.imageId,
        width: row.image.width,
        height: row.image.height,
        kind: row.image.kind,
        bytes: row.bytes,
        sha256: imageHash(row.image, row.data),
        rect: [...rect]
      })
    }
    const paints = [...e.paths].filter(([i]) => i > begin && i < end)
    if (
      paints.some(
        ([, s]) =>
          !inside(group.clip, s.clip) ||
          ![s.fillAlpha, s.strokeAlpha].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
      )
    )
      return
    const metadata = Object.freeze({
      pageNumber: snapshot.pageNumber,
      sourceSha256: snapshot.sourceSha256,
      images: Object.freeze(
        imageViews.map((r) => Object.freeze({ ...r, rect: Object.freeze(r.rect) }))
      )
    })
    proofs.set(
      metadata,
      Object.freeze({
        nativeOperators: o,
        nativeGraphics: snapshot.graphicsBounds,
        sourceSha256: snapshot.sourceSha256,
        pageNumber: snapshot.pageNumber,
        operators: digest(o),
        viewport: digest(v),
        graphics: digest(snapshot.graphicsBounds),
        begin,
        end,
        rect: Object.freeze([...group.rect]),
        clip: Object.freeze([...group.clip]),
        forms: Object.freeze(forms.map(Object.freeze)),
        ordinaryOperations: Object.freeze([...ordinaryOperations]),
        images: Object.freeze(
          images.map((row, index) =>
            Object.freeze({
              image: new WeakRef(row.image),
              data: new WeakRef(row.data),
              buffer: new WeakRef(row.data.buffer),
              offset: row.data.byteOffset,
              length: row.data.byteLength,
              identity: metadata.images[index]
            })
          )
        )
      })
    )
    return metadata
  } catch {
    return
  }
}

export function nativeIsolatedRasterScopeData(page, context) {
  try {
    const proof = proofs.get(context?.isolatedRasterScope)
    if (
      !proof ||
      context.operators !== proof.nativeOperators ||
      context.graphicsBounds !== proof.nativeGraphics ||
      page?.pageNumber !== proof.pageNumber ||
      context.pageNumber !== proof.pageNumber ||
      context.sourceSha256 !== proof.sourceSha256 ||
      page.rotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      digest(context.operators) !== proof.operators ||
      digest(context.viewport) !== proof.viewport ||
      digest(context.graphicsBounds) !== proof.graphics
    )
      return
    // Snapshot identities attest the completed render. Normal PDF.js cleanup
    // may release its cache; no decoded buffer is retained for later inference.
    // A still-live native view must continue to match its complete captured hash.
    for (const row of proof.images) {
      const image = row.image.deref(),
        data = row.data.deref(),
        expected = row.identity
      if (!image && !data) continue
      if (
        !data ||
        (image &&
          (image.data !== data ||
            image.width !== expected.width ||
            image.height !== expected.height ||
            image.kind !== expected.kind)) ||
        data.buffer !== row.buffer.deref() ||
        data.byteOffset !== row.offset ||
        data.byteLength !== row.length ||
        imageHash(image ?? expected, data) !== expected.sha256
      )
        return
    }
    return proof
  } catch {
    return
  }
}
