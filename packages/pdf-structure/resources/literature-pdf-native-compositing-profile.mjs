/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { types } from 'node:util'
function ownViewport(c) {
  if (!c || types.isProxy(c)) return
  const d = Object.getOwnPropertyDescriptor(c, 'viewport')
  return d && 'value' in d ? d.value : undefined
}
function nativeViewport(viewport) {
  if (!viewport || types.isProxy(viewport)) return
  for (const key of ['width', 'height', 'scale', 'rotation', 'transform']) {
    const descriptor = Object.getOwnPropertyDescriptor(viewport, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return
  }
  let current = viewport
  const chain = []
  for (let depth = 0; current && depth < 8; depth++) {
    if (types.isProxy(current)) return
    const object = current,
      prototype = Object.getPrototypeOf(current),
      descriptor = Object.getOwnPropertyDescriptor(current, 'convertToViewportPoint')
    chain.push({ object, prototype, descriptor })
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') return
      return () =>
        chain.every(({ object, prototype, descriptor }) => {
          const next = Object.getOwnPropertyDescriptor(object, 'convertToViewportPoint')
          return (
            Object.getPrototypeOf(object) === prototype &&
            (descriptor
              ? next &&
                Object.hasOwn(next, 'value') &&
                next.value === descriptor.value &&
                next.writable === descriptor.writable &&
                next.enumerable === descriptor.enumerable &&
                next.configurable === descriptor.configurable
              : !next)
          )
        })
    }
    current = prototype
  }
}
import { createHash } from 'node:crypto'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype),
  byteBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get,
  byteOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset').get,
  byteLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength').get,
  elementLength = Object.getOwnPropertyDescriptor(typedPrototype, 'length').get,
  bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get,
  resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get,
  typedNames = new Map(
    [
      Int8Array,
      Uint8Array,
      Uint8ClampedArray,
      Int16Array,
      Uint16Array,
      Int32Array,
      Uint32Array,
      Float32Array,
      Float64Array
    ].map((type) => [type.prototype, type.name])
  )

// Read the native byte window without executing shadowed view/buffer fields or
// creating one JavaScript property name for every pixel byte. Unused typed-view
// expandos are not interpreted; metadata objects still require own data fields.
export function nativeCompositingByteWindow(value) {
  try {
    if (!value || types.isProxy(value) || !ArrayBuffer.isView(value)) return
    const prototype = Object.getPrototypeOf(value),
      type = typedNames.get(prototype)
    if (
      !type ||
      Object.getOwnPropertySymbols(value).length ||
      ['buffer', 'byteOffset', 'byteLength', 'length', 'subarray', 'constructor', 'toJSON'].some(
        (key) => Object.getOwnPropertyDescriptor(value, key)
      )
    )
      return
    const buffer = Reflect.apply(byteBuffer, value, [])
    if (
      types.isProxy(buffer) ||
      Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
      Object.getOwnPropertySymbols(buffer).length ||
      ['byteLength', 'resizable', 'maxByteLength', 'resize', 'transfer', 'toJSON'].some((key) =>
        Object.getOwnPropertyDescriptor(buffer, key)
      ) ||
      (resizable && Reflect.apply(resizable, buffer, []))
    )
      return
    return {
      prototype,
      type,
      buffer,
      bufferByteLength: Reflect.apply(bufferLength, buffer, []),
      byteOffset: Reflect.apply(byteOffset, value, []),
      byteLength: Reflect.apply(byteLength, value, []),
      length: Reflect.apply(elementLength, value, [])
    }
  } catch {
    return
  }
}

const byteHash = (view) =>
  createHash('sha256')
    .update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    .digest('hex')

// This retainer is private to the compositing family. Ordinary packet/resource
// contracts retain their original validator. Pixel buffers are hashed in place;
// every owning metadata descriptor, prototype, reference and byte window remains
// bound across the asynchronous native crop operation.
export function retainNativeCompositingInputs(roots, viewport) {
  try {
    const seen = new Set(),
      buffers = new Set(),
      checks = []
    let bytes = 0
    const visit = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return true
      if (types.isProxy(value) || seen.size >= 65536) return false
      seen.add(value)
      if (ArrayBuffer.isView(value)) {
        const initial = nativeCompositingByteWindow(value)
        if (!initial) return false
        if (!buffers.has(initial.buffer)) {
          buffers.add(initial.buffer)
          bytes += initial.bufferByteLength
        }
        if (bytes > 16 * 1024 * 1024) return false
        const sha256 = byteHash(initial)
        checks.push(() => {
          const current = nativeCompositingByteWindow(value)
          return (
            current &&
            current.prototype === initial.prototype &&
            current.buffer === initial.buffer &&
            current.bufferByteLength === initial.bufferByteLength &&
            current.byteOffset === initial.byteOffset &&
            current.byteLength === initial.byteLength &&
            current.length === initial.length &&
            byteHash(current) === sha256
          )
        })
        return true
      }
      const prototype = Object.getPrototypeOf(value),
        descriptors = Object.getOwnPropertyDescriptors(value),
        keys = Reflect.ownKeys(descriptors)
      if (
        (value !== viewport && ![Object.prototype, Array.prototype, null].includes(prototype)) ||
        keys.some((key) => !Object.hasOwn(descriptors[key], 'value'))
      )
        return false
      bytes += 64 + keys.length * 8
      for (const key of keys)
        bytes +=
          (typeof key === 'string' ? key.length * 2 : 0) +
          (typeof descriptors[key].value === 'string' ? descriptors[key].value.length * 2 : 0)
      if (bytes > 16 * 1024 * 1024) return false
      checks.push(() => {
        const currentKeys = Reflect.ownKeys(value)
        return (
          Object.getPrototypeOf(value) === prototype &&
          currentKeys.length === keys.length &&
          currentKeys.every((key, index) => key === keys[index]) &&
          keys.every((key) => {
            const current = Object.getOwnPropertyDescriptor(value, key),
              initial = descriptors[key]
            return (
              current &&
              Object.hasOwn(current, 'value') &&
              Object.is(current.value, initial.value) &&
              current.writable === initial.writable &&
              current.enumerable === initial.enumerable &&
              current.configurable === initial.configurable
            )
          })
        )
      })
      return keys.every((key) => visit(descriptors[key].value))
    }
    if (!roots.every(visit)) return
    return () => {
      try {
        return checks.every((check) => check())
      } catch {
        return false
      }
    }
  } catch {
    return
  }
}

// Stream typed bytes into the digest. JSON/Array.from would turn a valid 15 MB
// RGBA view into millions of numbers and exceed the worker's 512 MiB heap.
function digest(root) {
  const hash = createHash('sha256'),
    active = new Set()
  const visit = (value) => {
    if (value === null) return void hash.update('null;')
    if (typeof value !== 'object') {
      if (typeof value === 'function') throw Error('Unproved digest function')
      const text = typeof value === 'undefined' ? 'undefined' : JSON.stringify(value)
      hash.update(`${typeof value}:${text.length}:`).update(text)
      return
    }
    if (types.isProxy(value) || active.has(value)) throw Error('Unproved digest reference')
    if (ArrayBuffer.isView(value)) {
      const view = nativeCompositingByteWindow(value)
      if (!view) throw Error('Unproved digest byte window')
      hash.update(`view:${view.type}:${view.byteLength}:`)
      hash.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
      return
    }
    active.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(descriptors)
    hash.update(`${Array.isArray(value) ? 'array' : 'object'}:${keys.length}:{`)
    for (const key of keys) {
      if (typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value'))
        throw Error('Unproved digest property')
      hash.update(`${key.length}:`).update(key)
      visit(descriptors[key].value)
    }
    hash.update('}')
    active.delete(value)
  }
  visit(root)
  return hash.digest('hex')
}

const proofs = new WeakMap(),
  finite = (v, n) =>
    (Array.isArray(v) || ArrayBuffer.isView(v)) &&
    v.length === n &&
    Array.from(v).every(Number.isFinite),
  valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3],
  shape = (v, keys) => v && Object.keys(v).sort().join(',') === keys
const state = (a, mask) =>
  Array.isArray(a) &&
  a.length === 1 &&
  Array.isArray(a[0]) &&
  a[0].every(
    (e) =>
      Array.isArray(e) &&
      e.length === 2 &&
      ((['CA', 'ca'].includes(e[0]) && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1) ||
        (e[0] === 'BM' && e[1] === 'source-over') ||
        (e[0] === 'SMask' && (e[1] === false || (mask && e[1] === true))))
  )
function finiteResource(root) {
  const seen = new Set()
  const walk = (x) => {
    if (x === undefined || x === null || typeof x === 'string' || typeof x === 'boolean')
      return true
    if (typeof x === 'number') return Number.isFinite(x)
    if (typeof x !== 'object' || seen.size >= 65536) return false
    if (seen.has(x)) return true
    seen.add(x)
    if (ArrayBuffer.isView(x)) return Array.from(x).every(Number.isFinite)
    return Reflect.ownKeys(x).every((k) => {
      const d = Object.getOwnPropertyDescriptor(x, k)
      return typeof k === 'string' && d && 'value' in d && walk(d.value)
    })
  }
  return walk(root)
}
function closedArguments(root) {
  const seen = new Set(),
    forbidden = new Set(
      Object.entries(OPS)
        .filter(([name]) => /Text|Font|Char|WordSpacing|HScale|Leading/u.test(name))
        .map(([, code]) => code)
    )
  const walk = (x) => {
    if (!x || typeof x !== 'object') return true
    if (seen.has(x)) return true
    seen.add(x)
    if (ArrayBuffer.isView(x)) return true
    const d = Object.getOwnPropertyDescriptor(x, 'fnArray')
    if (d) {
      if (!('value' in d) || !Array.isArray(d.value) || d.value.some((op) => forbidden.has(op)))
        return false
      const a = Object.getOwnPropertyDescriptor(x, 'argsArray')
      if (!a || !('value' in a) || !Array.isArray(a.value) || a.value.length !== d.value.length)
        return false
    }
    return Reflect.ownKeys(x).every((k) => {
      const q = Object.getOwnPropertyDescriptor(x, k)
      return q && 'value' in q && walk(q.value)
    })
  }
  return walk(root)
}
function tiling(ir) {
  if (
    !Array.isArray(ir) ||
    ir.length !== 9 ||
    ir[0] !== 'TilingPattern' ||
    ir[1] !== null ||
    !finite(ir[3], 6) ||
    ir[3][0] * ir[3][3] === ir[3][1] * ir[3][2] ||
    !valid(ir[4]) ||
    ![ir[5], ir[6]].every((x) => Number.isFinite(x) && x > 0 && x <= 1e6) ||
    ir[7] !== 1 ||
    ir[8] !== 1
  )
    return
  const p = ir[2],
    expected = [
      OPS.paintFormXObjectBegin,
      OPS.save,
      OPS.setGState,
      OPS.setFillRGBColor,
      OPS.setGState,
      OPS.constructPath,
      OPS.restore,
      OPS.paintFormXObjectEnd
    ]
  if (
    !shape(p, 'argsArray,fnArray,length') ||
    p.length !== 8 ||
    JSON.stringify(p.fnArray) !== JSON.stringify(expected) ||
    p.argsArray.length !== 8 ||
    p.argsArray[0]?.[0] !== null ||
    !valid(p.argsArray[0]?.[1]) ||
    JSON.stringify(Array.from(p.argsArray[0][1])) !== JSON.stringify(ir[4]) ||
    !state(p.argsArray[2], false) ||
    !state(p.argsArray[4], false) ||
    !/^#[a-f0-9]{6}$/iu.test(p.argsArray[3]?.[0]) ||
    p.argsArray[5]?.[0] !== OPS.fill ||
    !Array.isArray(p.argsArray[5]) ||
    p.argsArray[5].length !== 3 ||
    !Array.isArray(p.argsArray[5][1]) ||
    p.argsArray[5][1].length !== 1 ||
    !(p.argsArray[5][1][0] instanceof Float32Array) ||
    p.argsArray[5][1][0].length > 65536 ||
    !(p.argsArray[5][2] instanceof Float32Array) ||
    !valid(p.argsArray[5][2]) ||
    !finiteResource(p) ||
    !closedArguments(p)
  )
    return
  return {
    digest: digest(ir),
    operations: p.fnArray.length,
    matrix: ir[3],
    bbox: ir[4],
    xStep: ir[5],
    yStep: ir[6],
    paintType: ir[7],
    tilingType: ir[8],
    fullProgram: p
  }
}
export function createNativeCompositingProfile(page, tokens, context, images) {
  try {
    if (types.isProxy(images) || !Array.isArray(images)) return
    const viewport = ownViewport(context),
      viewportUnchanged = nativeViewport(viewport)
    if (!viewportUnchanged) return
    const unchanged = retainNativeCompositingInputs(
      [page, tokens, context, images],
      ownViewport(context)
    )
    if (!unchanged) return
    if (
      !page ||
      !context ||
      !Number.isSafeInteger(page.pageNumber) ||
      page.pageNumber < 1 ||
      page.pageNumber !== context.pageNumber ||
      typeof context.sourceSha256 !== 'string' ||
      !/^([a-f0-9]{64})$/u.test(context.sourceSha256) ||
      page.invalidGraphicsBounds !== 0 ||
      page.rotation !== 0 ||
      ![page.width, page.height].every((n) => Number.isFinite(n) && n > 0) ||
      !viewport ||
      viewport.scale !== 1 ||
      viewport.rotation !== 0 ||
      viewport.width !== page.width ||
      viewport.height !== page.height ||
      !finite(viewport.transform, 6) ||
      viewport.transform[0] <= 0 ||
      viewport.transform[1] !== 0 ||
      viewport.transform[2] !== 0 ||
      viewport.transform[3] !== -viewport.transform[0] ||
      !Array.isArray(tokens) ||
      !Array.isArray(context.operators?.fnArray) ||
      context.operators.fnArray.length !== context.operators.argsArray?.length ||
      context.operators.fnArray.length > 100000 ||
      !finiteResource(context.operators) ||
      !Array.isArray(images)
    )
      return
    const o = context.operators,
      groups = [],
      stack = []
    let currentRoot
    const allowed = new Set([
      OPS.save,
      OPS.restore,
      OPS.transform,
      OPS.beginGroup,
      OPS.endGroup,
      OPS.paintFormXObjectBegin,
      OPS.paintFormXObjectEnd,
      OPS.setGState,
      OPS.dependency,
      OPS.paintImageXObject,
      OPS.setFillRGBColor,
      OPS.setStrokeRGBColor,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.setLineJoin,
      OPS.setDash,
      OPS.setMiterLimit,
      OPS.constructPath,
      OPS.setFillColorN
    ])
    let root,
      maskDefinition,
      maskActivations = 0
    const patterns = [],
      imageOps = []
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.beginGroup) {
        const g = a?.[0]
        if (
          !shape(g, 'bbox,isolated,knockout,matrix,smask') ||
          g.matrix !== null ||
          !valid(g.bbox) ||
          g.isolated !== true ||
          g.knockout !== false ||
          groups.length >= 64
        )
          return
        if (g.smask !== null) {
          if (
            !shape(g.smask, 'backdrop,subtype') ||
            g.smask.subtype !== 'Alpha' ||
            g.smask.backdrop !== undefined ||
            maskDefinition
          )
            return
          maskDefinition = i
        }
        const node = {
          kind: 'group',
          begin: i,
          args: g,
          depth: stack.filter((x) => x.kind === 'group').length
        }
        if (!currentRoot) {
          if (root) return
          root = node
          currentRoot = node
        }
        groups.push(node)
        stack.push(node)
      } else if (currentRoot) {
        if (!allowed.has(op) || !closedArguments(a)) return
        if (op === OPS.save) stack.push({ kind: 'save', begin: i })
        else if (op === OPS.paintFormXObjectBegin) {
          if (
            !Array.isArray(a) ||
            a.length !== 2 ||
            (a[0] !== null && !finite(a[0], 6)) ||
            (a[1] !== null && !valid(a[1]))
          )
            return
          stack.push({ kind: 'form', begin: i })
        } else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
          const end = stack.pop(),
            expected =
              op === OPS.restore ? 'save' : op === OPS.paintFormXObjectEnd ? 'form' : 'group'
          if (end?.kind !== expected) return
          end.end = i
          if (expected === 'group' && digest(end.args) !== digest(a?.[0])) return
          if (end === root) {
            root.end = i
            currentRoot = undefined
          }
        } else if (op === OPS.transform) {
          if (!finite(a, 6) || a[0] * a[3] === a[1] * a[2]) return
        } else if (op === OPS.dependency) {
          if (
            !Array.isArray(a) ||
            a.some((id) => typeof id !== 'string' || !images.some((image) => image.imageId === id))
          )
            return
        } else if (op === OPS.setGState) {
          if (!state(a, true)) return
          for (const e of a[0])
            if (e[0] === 'SMask' && e[1] === true) {
              if (
                maskDefinition === undefined ||
                maskDefinition >= i ||
                !groups.find((g) => g.begin === maskDefinition && g.end < i)
              )
                return
              maskActivations++
            }
        } else if (op === OPS.setFillColorN) {
          const pattern = tiling(a)
          if (!pattern) return
          patterns.push({ i, ...pattern })
        } else if (op === OPS.paintImageXObject) imageOps.push(i)
      }
    }
    if (
      !root ||
      currentRoot ||
      stack.length ||
      maskDefinition === undefined ||
      maskActivations !== 1 ||
      !patterns.length ||
      new Set(patterns.map((p) => p.digest)).size !== 1 ||
      imageOps.length !== 1 ||
      images.length !== 1 ||
      groups.some((g) => !Number.isSafeInteger(g.end)) ||
      o.fnArray.some(
        (op, i) =>
          (op === OPS.setFillColorN || op === OPS.beginGroup) && (i < root.begin || i > root.end)
      )
    )
      return
    const image = images[0],
      a = o.argsArray[imageOps[0]],
      imageView = nativeCompositingByteWindow(image.data),
      actual = context.graphicsBounds.filter(
        (g) => g.kind === 'image' && g.operationIndex === image.operationIndex
      )
    if (
      !shape(image, 'data,height,imageId,kind,operationIndex,sourceSha256,width') ||
      !Number.isSafeInteger(image.operationIndex) ||
      image.operationIndex < 0 ||
      !Number.isSafeInteger(image.width) ||
      image.width <= 0 ||
      !Number.isSafeInteger(image.height) ||
      image.height <= 0 ||
      image.operationIndex !== imageOps[0] ||
      image.sourceSha256 !== context.sourceSha256 ||
      image.imageId !== a?.[0] ||
      image.width !== a[1] ||
      image.height !== a[2] ||
      image.kind !== 3 ||
      imageView?.prototype !== Uint8Array.prototype ||
      imageView.length !== image.width * image.height * 4 ||
      imageView.length > 16_000_000 ||
      actual.length !== 1
    )
      return
    const imageHash = createHash('sha256')
      .update(`${image.width}:${image.height}:${image.kind}:`)
      .update(new Uint8Array(imageView.buffer, imageView.byteOffset, imageView.byteLength))
      .digest('hex')
    if (imageHash !== actual[0].imageHash) return
    let m = [1, 0, 0, 1, 0, 0]
    const prior = []
    for (let i = 0; i < root.begin; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save) prior.push(m)
      else if (op === OPS.restore) {
        if (!prior.length) return
        m = prior.pop()
      } else if (op === OPS.transform) {
        if (!finite(a, 6)) return
        m = Util.transform(m, a)
      } else if (![OPS.setFillRGBColor, OPS.setStrokeRGBColor, OPS.dependency].includes(op)) return
    }
    const matrix = Util.transform(context.viewport.transform, m),
      b = root.args.bbox,
      points = [
        [b[0], b[1]],
        [b[2], b[1]],
        [b[2], b[3]],
        [b[0], b[3]]
      ]
    for (const p of points) Util.applyTransform(p, matrix)
    const rect = [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
    if (!valid(rect) || rect[0] < 0 || rect[1] < 0 || rect[2] > page.width || rect[3] > page.height)
      return
    const sourceDigest = digest({
        o,
        images,
        pageNumber: page.pageNumber,
        source: context.sourceSha256
      }),
      scope = {
        begin: root.begin,
        end: root.end,
        rect,
        matrix,
        groups,
        patterns,
        imageHash,
        maskDefinition,
        maskActivations,
        sourceDigest,
        preservesSourceAlpha: true,
        recursiveFontOrTextOperations: 0
      }
    const handle = Object.freeze({})
    const scopeUnchanged = retainNativeRecoveryInputs([scope])
    if (!scopeUnchanged) return
    proofs.set(handle, {
      page,
      tokens,
      context,
      images,
      scope,
      unchanged,
      scopeUnchanged,
      viewportUnchanged
    })
    return handle
  } catch {
    return
  }
}
export function nativeCompositingProfileData(handle, page, tokens, context) {
  const p = proofs.get(handle)
  return p &&
    p.page === page &&
    p.tokens === tokens &&
    p.context === context &&
    p.viewportUnchanged() &&
    p.unchanged() &&
    p.scopeUnchanged() &&
    p.scope.sourceDigest ===
      digest({
        o: context.operators,
        images: p.images,
        pageNumber: page.pageNumber,
        source: context.sourceSha256
      })
    ? p.scope
    : undefined
}

export function nativeCompositingPaintSpan(handle, operators, viewport) {
  const p = proofs.get(handle)
  return p && p.context.operators === operators && p.context.viewport === viewport
    ? nativeCompositingProfileData(handle, p.page, p.tokens, p.context)
    : undefined
}
