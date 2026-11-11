/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Complete the last opaque raster after generic association padding.
// Native paragraph and caption proofs never create text ownership claims.
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { Path2D, createCanvas, loadImage } from '@napi-rs/canvas'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import {
  nativeRecoveryOwnValues,
  retainNativeRecoveryInputs
} from './literature-pdf-native-figure-recovery-profile.mjs'
import { getPdfCropRasterProtectionFromPng, renderPdfCrop } from './literature-pdf-crop.mjs'

const isolatedCrops = new WeakMap(),
  cropHit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  cropExpand = (r, n) => r.map((v, i) => v + (i < 2 ? -n : n)),
  cropContains = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] : v <= a[i])),
  cropUnion = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ],
  cropValid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  bytesHash = (data) => createHash('sha256').update(data).digest('hex'),
  dataSlot = (object, key) => {
    for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
      const d = Object.getOwnPropertyDescriptor(owner, key)
      if (d) return Object.hasOwn(d, 'value') ? d.value : undefined
    }
  },
  bindSlots = (object, keys) => {
    const chain = []
    for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
      if (types.isProxy(owner) || chain.length === 8) return
      chain.push({
        owner,
        parent: Object.getPrototypeOf(owner),
        entries: keys.map((key) => [key, Object.getOwnPropertyDescriptor(owner, key)])
      })
    }
    return () =>
      chain.every(
        ({ owner, parent, entries }) =>
          Object.getPrototypeOf(owner) === parent &&
          entries.every(([key, before]) => {
            const now = Object.getOwnPropertyDescriptor(owner, key)
            return before
              ? !!now &&
                  ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(
                    (field) => now[field] === before[field]
                  )
              : !now
          })
      )
  }

const pathPrototype = Path2D.prototype,
  pathMethods = Object.fromEntries(
    [
      'moveTo',
      'lineTo',
      'bezierCurveTo',
      'quadraticCurveTo',
      'closePath',
      'equals',
      'toSVGString',
      'getFillType'
    ].map((key) => [key, dataSlot(pathPrototype, key)])
  ),
  nativePathMethodsCurrent = () =>
    Object.entries(pathMethods).every(
      ([key, value]) => typeof value === 'function' && dataSlot(pathPrototype, key) === value
    )

// PDF.js compiles its finite DrawOPS array into a native cache. Prove the
// compiled geometry itself, retaining both its identity and internal geometry.
function compiledPathBinding(a, b) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !== 3 ||
    b.length !== 3 ||
    a[0] !== b[0] ||
    !equal(a[2], b[2]) ||
    !Array.isArray(a[1]) ||
    a[1].length !== 1 ||
    !Array.isArray(b[1]) ||
    b[1].length !== 1 ||
    !nativePathMethodsCurrent()
  )
    return
  const raw = a[1][0],
    actual = b[1][0]
  if (
    (!Array.isArray(raw) && !ArrayBuffer.isView(raw)) ||
    !raw.length ||
    raw.length > 100000 ||
    !Array.from(raw).every(Number.isFinite) ||
    !actual ||
    types.isProxy(actual) ||
    Object.getPrototypeOf(actual) !== pathPrototype ||
    Reflect.ownKeys(actual).length
  )
    return
  const expected = new Path2D()
  for (let i = 0; i < raw.length;) {
    const op = raw[i++],
      count = [2, 2, 6, 4, 0][op]
    if (count === undefined || i + count > raw.length) return
    const args = Array.prototype.slice.call(raw, i, i + count),
      method = ['moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'closePath'][op]
    pathMethods[method].call(expected, ...args)
    i += count
  }
  if (!pathMethods.equals.call(expected, actual)) return
  const slots = bindSlots(b, Reflect.ownKeys(b)),
    container = bindSlots(b[1], Reflect.ownKeys(b[1])),
    methods = bindSlots(actual, Object.keys(pathMethods)),
    svg = pathMethods.toSVGString.call(actual),
    fill = pathMethods.getFillType.call(actual)
  if (!slots || !container || !methods) return
  return () =>
    slots() &&
    container() &&
    methods() &&
    nativePathMethodsCurrent() &&
    Object.getPrototypeOf(actual) === pathPrototype &&
    !Reflect.ownKeys(actual).length &&
    pathMethods.equals.call(expected, actual) &&
    pathMethods.toSVGString.call(actual) === svg &&
    pathMethods.getFillType.call(actual) === fill
}

// An ordinary RGBA image is not an opaque-image snapshot claim. Bind its real
// loaded object and complete bytes to the same live page, text and operator list.
function liveRasterImages(context, scope, candidates) {
  const options = nativeRecoveryOwnValues(scope)
  if (!options) return
  const { nativePage, pageContent, operators } = options,
    retained = retainNativeRecoveryInputs([pageContent, operators]),
    scopeCurrent = bindSlots(scope, Reflect.ownKeys(scope)),
    source = context.content,
    forward = new Map(),
    reverse = new Map()
  if (
    ![1, 2].includes(candidates.length) ||
    !retained ||
    !scopeCurrent ||
    !nativePage ||
    types.isProxy(nativePage) ||
    !Array.isArray(pageContent?.items) ||
    pageContent.items.length !== source.items.length ||
    !equal(context.operators.fnArray, operators?.fnArray) ||
    operators.argsArray.length !== context.operators.argsArray.length
  )
    return
  for (const [i, row] of source.items.entries()) {
    const other = pageContent.items[i]
    if (
      !other ||
      !['str', 'width', 'height', 'dir', 'hasEOL'].every((k) => row[k] === other[k]) ||
      !equal(row.transform, other.transform) ||
      !equal(source.styles[row.fontName], pageContent.styles?.[other.fontName]) ||
      (forward.has(row.fontName) && forward.get(row.fontName) !== other.fontName) ||
      (reverse.has(other.fontName) && reverse.get(other.fontName) !== row.fontName)
    )
      return
    forward.set(row.fontName, other.fontName)
    reverse.set(other.fontName, row.fontName)
  }
  for (const [i, op] of context.operators.fnArray.entries()) {
    const a = context.operators.argsArray[i],
      b = operators.argsArray[i]
    if (op !== OPS.setFont) continue
    if (
      !Array.isArray(a) ||
      !Array.isArray(b) ||
      a.length !== 2 ||
      b.length !== 2 ||
      a[1] !== b[1] ||
      typeof a[0] !== 'string' ||
      typeof b[0] !== 'string' ||
      (forward.has(a[0]) && forward.get(a[0]) !== b[0]) ||
      (reverse.has(b[0]) && reverse.get(b[0]) !== a[0])
    )
      return
    forward.set(a[0], b[0])
    reverse.set(b[0], a[0])
  }
  for (const [i, op] of context.operators.fnArray.entries()) {
    if (op !== OPS.paintImageXObject) continue
    const a = context.operators.argsArray[i],
      b = operators.argsArray[i]
    if (
      !Array.isArray(a) ||
      !Array.isArray(b) ||
      a.length !== 3 ||
      b.length !== 3 ||
      typeof a[0] !== 'string' ||
      typeof b[0] !== 'string' ||
      a[1] !== b[1] ||
      a[2] !== b[2] ||
      (forward.has(a[0]) && forward.get(a[0]) !== b[0]) ||
      (reverse.has(b[0]) && reverse.get(b[0]) !== a[0])
    )
      return
    forward.set(a[0], b[0])
    reverse.set(b[0], a[0])
  }
  for (const [i, op] of context.operators.fnArray.entries()) {
    const a = context.operators.argsArray[i],
      expected =
        op === OPS.setFont
          ? [forward.get(a[0]), a[1]]
          : op === OPS.paintImageXObject
            ? [forward.get(a[0]), a[1], a[2]]
            : op === OPS.dependency
              ? a.map((id) => forward.get(id) ?? id)
              : a
    if (!equal(expected, operators.argsArray[i])) return
    if (
      op === OPS.setGState &&
      a[0].some(
        ([key, value]) =>
          (['ca', 'CA'].includes(key) && value !== 1) ||
          (key === 'BM' && !['Normal', 'source-over'].includes(value)) ||
          (key === 'SMask' && value !== false)
      )
    )
      return
  }
  const store = dataSlot(nativePage, 'objs'),
    get = store && dataSlot(store, 'get'),
    viewportGet = dataSlot(nativePage, 'getViewport'),
    pageCurrent = bindSlots(nativePage, ['objs', 'render', 'getViewport', 'rotate']),
    storeCurrent = store && bindSlots(store, ['get']),
    images = []
  if (
    typeof get !== 'function' ||
    typeof viewportGet !== 'function' ||
    !pageCurrent ||
    !storeCurrent
  )
    return
  const viewportCurrent = () => {
    const viewport = viewportGet.call(nativePage, { scale: 1, rotation: context.viewport.rotation })
    if (!viewport || types.isProxy(viewport)) return false
    const value = {},
      fields = ['width', 'height', 'scale', 'rotation', 'transform']
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(viewport, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false
      value[key] = descriptor.value
    }
    return (
      ['width', 'height', 'scale', 'rotation'].every((key) => Number.isFinite(value[key])) &&
      Array.isArray(value.transform) &&
      !!retainNativeRecoveryInputs([value.transform]) &&
      fields.every((key) => equal(value[key], context.viewport[key]))
    )
  }
  if (!viewportCurrent()) return
  let total = 0
  for (const candidate of candidates) {
    const args = operators.argsArray[candidate.operationIndex],
      image = get.call(store, args[0]),
      values = nativeRecoveryOwnValues(image)
    if (
      !values ||
      ![2, 3].includes(values.kind) ||
      values.width !== args[1] ||
      values.height !== args[2] ||
      !Number.isSafeInteger(values.width) ||
      values.width <= 0 ||
      !Number.isSafeInteger(values.height) ||
      values.height <= 0 ||
      values.bitmap != null
    )
      return
    const data = values.data,
      length = values.width * values.height * (values.kind === 3 ? 4 : 3)
    if (
      !data ||
      types.isProxy(data) ||
      ![Uint8Array.prototype, Uint8ClampedArray.prototype].includes(Object.getPrototypeOf(data)) ||
      !Number.isSafeInteger(length) ||
      data.byteLength !== length ||
      length > 8 * 1024 * 1024 ||
      (total += length) > candidates.length * 8 * 1024 * 1024
    )
      return
    const currentSlots = bindSlots(image, [
        'kind',
        'width',
        'height',
        'data',
        'bitmap',
        'interpolate',
        'dataLen',
        'ref'
      ]),
      buffer = data.buffer,
      offset = data.byteOffset,
      hash = bytesHash(data)
    if (!currentSlots) return
    images.push({
      candidate,
      image,
      kind: values.kind,
      current: () =>
        currentSlots() &&
        get.call(store, args[0]) === image &&
        data.buffer === buffer &&
        data.byteOffset === offset &&
        data.byteLength === length &&
        bytesHash(data) === hash
    })
  }
  const displays = [],
    bindDisplay = (display) => {
      if (
        !display ||
        !equal(display.fnArray, operators.fnArray) ||
        display.argsArray.length !== operators.argsArray.length
      )
        return false
      const map = new Map(),
        reverse = new Map(),
        pathCurrent = [],
        stable = []
      for (const [i, op] of operators.fnArray.entries()) {
        if (op !== OPS.paintImageXObject) continue
        const a = operators.argsArray[i],
          b = display.argsArray[i]
        if (
          !Array.isArray(b) ||
          b.length !== 3 ||
          typeof b[0] !== 'string' ||
          a[1] !== b[1] ||
          a[2] !== b[2] ||
          (map.has(a[0]) && map.get(a[0]) !== b[0]) ||
          (reverse.has(b[0]) && reverse.get(b[0]) !== a[0])
        )
          return false
        map.set(a[0], b[0])
        reverse.set(b[0], a[0])
      }
      for (const [i, op] of operators.fnArray.entries()) {
        const a = operators.argsArray[i],
          expected =
            op === OPS.paintImageXObject
              ? [map.get(a[0]), a[1], a[2]]
              : op === OPS.dependency
                ? a.map((id) => map.get(id) ?? id)
                : a
        if (!equal(expected, display.argsArray[i])) {
          const same =
            op === OPS.constructPath && compiledPathBinding(expected, display.argsArray[i])
          if (!same) return false
          pathCurrent.push(same)
          stable.push([display.argsArray[i][0], display.argsArray[i][2]])
        } else stable.push(display.argsArray[i])
      }
      const refs = []
      for (const row of images) {
        const id = display.argsArray[row.candidate.operationIndex][0],
          image = get.call(store, id),
          values = nativeRecoveryOwnValues(image),
          data = values?.data,
          bound = bindSlots(image, [
            'kind',
            'width',
            'height',
            'data',
            'bitmap',
            'interpolate',
            'dataLen',
            'ref'
          ])
        if (
          !values ||
          !bound ||
          values.kind !== row.kind ||
          values.width !== row.image.width ||
          values.height !== row.image.height ||
          values.bitmap != null ||
          !['ref', 'interpolate', 'dataLen'].every(
            (key) =>
              Object.hasOwn(values, key) === Object.hasOwn(row.image, key) &&
              equal(values[key], row.image[key])
          ) ||
          !data ||
          types.isProxy(data) ||
          ![Uint8Array.prototype, Uint8ClampedArray.prototype].includes(
            Object.getPrototypeOf(data)
          ) ||
          data.byteLength !== row.image.data.byteLength ||
          bytesHash(data) !== bytesHash(row.image.data)
        )
          return false
        const buffer = data.buffer,
          offset = data.byteOffset,
          length = data.byteLength,
          hash = bytesHash(data)
        refs.push(
          () =>
            bound() &&
            get.call(store, id) === image &&
            data.buffer === buffer &&
            data.byteOffset === offset &&
            data.byteLength === length &&
            bytesHash(data) === hash
        )
      }
      const listSlots = bindSlots(display, ['fnArray', 'argsArray']),
        argSlots = bindSlots(display.argsArray, Reflect.ownKeys(display.argsArray)),
        keep = retainNativeRecoveryInputs([display.fnArray, stable])
      if (!keep || !listSlots || !argSlots) return false
      displays.push(
        () =>
          listSlots() &&
          argSlots() &&
          keep() &&
          pathCurrent.every((same) => same()) &&
          refs.every((same) => same())
      )
      return true
    },
    current = () =>
      !!nativeRecoveryOwnValues(scope) &&
      equal(Reflect.ownKeys(scope), Reflect.ownKeys(options)) &&
      scopeCurrent() &&
      retained() &&
      pageCurrent() &&
      viewportCurrent() &&
      storeCurrent() &&
      dataSlot(nativePage, 'objs') === store &&
      images.every((image) => image.current()) &&
      displays.every((same) => same())
  return current() ? { nativePage, operators, images, current, bindDisplay } : undefined
}

// A complete ordinary page packet can isolate one whole opaque image even
// when an unrelated heading was joined to its coarse graphics envelope.
// Only the privately retained plan grants authority; serialized geometry does not.
export function nativeIsolatedOpaqueRasterCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect = figure?.rect,
  live
) {
  try {
    const values = nativeRecoveryOwnValues(context)
    if (!values) return
    const prototype = Object.getPrototypeOf(context),
      descriptors = Object.getOwnPropertyDescriptors(context),
      keys = Reflect.ownKeys(descriptors),
      input = Object.fromEntries(
        [
          'operators',
          'glyphBounds',
          'skippedSpaceGlyphs',
          'opaqueRasterImages',
          'graphicsBounds',
          'viewport',
          'content',
          'pageNumber',
          'sourceSha256'
        ]
          .filter((key) => Object.hasOwn(values, key))
          .map((key) => [key, values[key]])
      ),
      current = retainNativeRecoveryInputs(
        [page, figure, captions, tables, tokens, input, publishedRect],
        input.viewport
      ),
      diagnostic = figure?.issue ?? figure?.reason,
      missing = figure?.rect == null && diagnostic === 'ambiguous-graphic-direction'
    if (
      !current ||
      (!missing && (!cropValid(figure?.rect) || !cropValid(publishedRect))) ||
      !cropValid(figure.caption?.rect) ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.formCropRaster ||
      figure.headerRaster ||
      figure.fallbackFigure ||
      (figure.reason &&
        (!['native-raster-side-by-side', 'ambiguous-graphic-direction'].includes(figure.reason) ||
          (figure.issue && figure.issue !== figure.reason))) ||
      (diagnostic && !missing && diagnostic !== 'native-raster-side-by-side') ||
      figure.caption.page !== page.pageNumber ||
      figure.caption.regions ||
      input.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(input.sourceSha256 ?? '') ||
      !Array.isArray(captions) ||
      !Array.isArray(tables) ||
      !tables.every(cropValid) ||
      page.invalidGraphicsBounds !== 0
    )
      return
    const p = nativePageTextPacketInventory(page, tokens, input, true)
    // This is a complete foreign-paint inventory, not a Source ownership claim.
    if (!p || p.records.length > 4096 || p.evidence.images.length > 8) return
    if (
      p.o.fnArray.some(
        (op, i) =>
          op === OPS.setGState &&
          p.o.argsArray[i][0].some(([key, value]) => ['ca', 'CA'].includes(key) && value !== 1)
      )
    )
      return
    const capTolerance = Number.EPSILON * Math.max(page.width, page.height) * 64,
      cap = p.records.filter((r) =>
        r.rect.every((v, i) =>
          i < 2
            ? v >= figure.caption.rect[i] - capTolerance
            : v <= figure.caption.rect[i] + capTolerance
        )
      ),
      capInk = cap
        .flatMap((r) => r.part.map((q) => q.g))
        .filter((g) => !g.rendererSkipped && cropValid(g.ink)),
      candidates = p.evidence.images.filter((im) =>
        missing
          ? capInk.length &&
            (im.rect[0] + im.rect[2]) / 2 > figure.caption.rect[0] &&
            (im.rect[0] + im.rect[2]) / 2 < figure.caption.rect[2] &&
            im.rect[3] <= Math.min(...capInk.map((g) => g.ink[1])) &&
            Math.abs(figure.caption.rect[1] - im.rect[3]) <=
              Math.max(...cap.map((r) => r.r.height)) * 1.5
          : cropHit(im.rect, figure.rect)
      )
    if (missing ? candidates.length !== 1 : ![1, 2].includes(candidates.length)) return
    if (diagnostic && !missing && candidates.length !== 2) return
    const liveProof = live && liveRasterImages(input, live, candidates)
    if ((missing || figure.reason) && !liveProof) return
    if (
      candidates.some((image) => {
        const identity =
            input.opaqueRasterImages?.filter((im) => im.operationIndex === image.operationIndex) ??
            [],
          args = p.o.argsArray[image.operationIndex]
        const opaque =
          identity.length === 1 &&
          identity[0].kind === 2 &&
          identity[0].imageId === args?.[0] &&
          identity[0].width === args[1] &&
          identity[0].height === args[2]
        const rgba = liveProof?.images.some((row) => row.candidate === image && row.kind === 3)
        return (!opaque && !rgba) || image.rect[1] >= figure.caption.rect[1]
      }) ||
      !cap.length ||
      !Array.isArray(figure.caption.lines) ||
      cap
        .map((r) => r.r.str)
        .join('')
        .replace(/\s/gu, '') !== figure.caption.lines.join('').replace(/\s/gu, '') ||
      captions.filter((c) => c.page === page.pageNumber && cropHit(c.rect, figure.caption.rect))
        .length !== 1
    )
      return
    const own = [],
      ownedGlyphs = new Set(),
      ownedRects = candidates.map((im) => im.rect)
    if (candidates.length === 2) {
      const [left, right] = [...candidates].sort((a, b) => a.rect[0] - b.rect[0]),
        w = left.rect[2] - left.rect[0],
        h = left.rect[3] - left.rect[1],
        tolerance = Math.max(w, h) * 1e-6,
        labels = p.records.filter(
          (r) =>
            r.rect[1] >= Math.max(left.rect[3], right.rect[3]) &&
            r.rect[1] < figure.caption.rect[1] &&
            r.rect[0] < right.rect[2] + tolerance &&
            r.rect[2] > left.rect[0]
        ),
        columns = [left, right].map((im) =>
          labels.filter(
            (r) =>
              (r.rect[0] + r.rect[2]) / 2 > im.rect[0] && (r.rect[0] + r.rect[2]) / 2 < im.rect[2]
          )
        )
      if (
        right.rect[0] <= left.rect[2] ||
        right.rect[0] - left.rect[2] > w ||
        Math.abs(right.rect[2] - right.rect[0] - w) > tolerance ||
        Math.abs(right.rect[1] - left.rect[1]) > tolerance ||
        Math.abs(right.rect[3] - left.rect[3]) > tolerance ||
        labels.length < 2 ||
        labels.length > 6 ||
        columns.some((rs, i) => {
          const image = [left, right][i],
            start = rs[0],
            size = start?.r.height
          return (
            !start ||
            !Number.isFinite(size) ||
            size <= 0 ||
            !new RegExp(`^\\(${i ? 'b' : 'a'}\\)\\s+\\S`, 'u').test(start.r.str) ||
            start.rect[1] - image.rect[3] > size ||
            rs.some(
              (r, n) =>
                r.r.dir !== 'ltr' ||
                r.r.transform[1] !== 0 ||
                r.r.transform[2] !== 0 ||
                r.r.transform[0] <= 0 ||
                r.r.transform[3] <= 0 ||
                Math.abs(r.r.height - size) > tolerance ||
                (n &&
                  (/^\([a-z]\)/u.test(r.r.str) ||
                    r.rect[1] - rs[n - 1].rect[1] < size ||
                    r.rect[1] - rs[n - 1].rect[1] > size * 1.5))
            )
          )
        }) ||
        columns.flat().length !== labels.length ||
        columns[0].at(-1).index >= columns[1][0].index
      )
        return
      own.push(...labels)
      for (const r of own) {
        ownedRects.push(r.rect)
        for (const q of r.part) {
          ownedGlyphs.add(q.g)
          if (!q.g.rendererSkipped) ownedRects.push(q.g.ink)
        }
      }
      if (
        !own.some((r) =>
          r.part.some(
            (q) =>
              !q.g.rendererSkipped && cropValid(q.g.ink) && !cropContains(publishedRect, q.g.ink)
          )
        )
      )
        return
    }
    const rect = cropExpand(cropUnion(ownedRects), 0.5),
      foreign = p.glyphs
        .filter((g) => !g.rendererSkipped && !ownedGlyphs.has(g))
        .map((g) => ({ rect: g.ink, floor: 0 }))
    foreign.push(
      ...p.evidence.images
        .filter((im) => !candidates.includes(im))
        .map((im) => ({ rect: im.rect, floor: 0 }))
    )
    for (const [i, state] of p.evidence.paths) {
      if (p.o.argsArray[i][0] === OPS.endPath) continue
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint) return
      foreign.push(paint)
    }
    const needsOwnPaintWitness =
      !missing && candidates.length === 1 && !foreign.some((q) => cropHit(figure.rect, q.rect))
    if (
      !cropValid(rect) ||
      rect.some((v, i) => (i < 2 ? v < 0 : v > (i % 2 ? page.height : page.width))) ||
      foreign.some((q) => !cropValid(q.rect) || cropHit(rect, q.rect)) ||
      tables.some((r) => cropHit(r, rect)) ||
      (needsOwnPaintWitness && (!liveProof || cropContains(publishedRect, candidates[0].rect)))
    )
      return
    const output = { rect },
      retained = retainNativeRecoveryInputs([output, foreign, candidates, own, ownedRects])
    if (!retained) return
    isolatedCrops.set(output, {
      page,
      ownedRects,
      foreign,
      live: liveProof,
      rotation: input.viewport.rotation,
      missing,
      needsOwnPaintWitness,
      publishedRect,
      image: candidates.length === 1 && !own.length ? candidates[0] : undefined,
      clipProgram: [...p.evidence.paths].every(([i]) => p.o.argsArray[i][0] === OPS.endPath),
      current: () => {
        if (
          !current() ||
          !retained() ||
          (liveProof && !liveProof.current()) ||
          !nativeRecoveryOwnValues(context) ||
          Object.getPrototypeOf(context) !== prototype ||
          Reflect.ownKeys(context).length !== keys.length
        )
          return false
        return keys.every((key, i) => {
          const d = Object.getOwnPropertyDescriptor(context, key),
            b = descriptors[key]
          return (
            Reflect.ownKeys(context)[i] === key &&
            d &&
            Object.hasOwn(d, 'value') &&
            Object.is(d.value, b.value) &&
            d.enumerable === b.enumerable &&
            d.configurable === b.configurable &&
            d.writable === b.writable
          )
        })
      }
    })
    return output
  } catch {
    return
  }
}

export function nativeIsolatedOpaqueRasterPngSafe(plan, png, rect, page) {
  return isolatedRasterPngSafe(plan, png, rect, page, false)
}

function isolatedRasterPngSafe(plan, png, rect, page, nativeRender) {
  try {
    const proof = isolatedCrops.get(plan),
      raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    return (
      !!proof &&
      proof.page === page &&
      proof.current() &&
      (!proof.needsOwnPaintWitness || proof.ownPaintProven || nativeRender) &&
      !!raster &&
      JSON.stringify(plan.rect) === JSON.stringify(rect) &&
      proof.ownedRects.every((r) =>
        r.every((v, i) =>
          i < 2 ? v - 1 / raster.scaleLower >= rect[i] : v + 1 / raster.scaleLower <= rect[i]
        )
      ) &&
      (proof.canonical
        ? Buffer.from(png).equals(proof.canonical)
        : (!proof.live || nativeRender) &&
          proof.foreign.every(
            (q) =>
              !cropHit(raster.protection, cropExpand(q.rect, (q.floor + 2) / raster.scaleLower))
          ))
    )
  } catch {
    return false
  }
}

// A preliminary association can already exclude foreign prose while still
// clipping its image. Stage that candidate privately, then require visible
// native-rendered image pixels outside the actual published crop. A complete
// 2x2 pixel block must be inside the own image and outside the old crop for
// every scale consistent with the actual ceil-sized PNG, including retries.
async function ownRasterPaintOutsidePublished(proof, png, rect) {
  const raster = getPdfCropRasterProtectionFromPng(png, rect, proof.page)
  if (!raster || !proof.image || !proof.current()) return false
  const image = await loadImage(png)
  if (!proof.current() || image.width !== raster.pixelWidth || image.height !== raster.pixelHeight)
    return false
  const canvas = createCanvas(image.width, image.height)
  try {
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data,
      nonwhite = (x, y) => {
        const i = (y * image.width + x) * 4
        // Optional recovery requires conservative visible contrast; near-white
        // JPEG/AA edge noise is not evidence that the published crop loses ink.
        return pixels[i + 3] === 255 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 250
      },
      epsilon = Math.max(proof.page.width, proof.page.height) * Number.EPSILON * 64
    for (let y = 0; y + 1 < image.height; y++)
      for (let x = 0; x + 1 < image.width; x++) {
        const box = [
          rect[0] + x / raster.scaleUpper - epsilon,
          rect[1] + y / raster.scaleUpper - epsilon,
          rect[0] + (x + 2) / raster.scaleLower + epsilon,
          rect[1] + (y + 2) / raster.scaleLower + epsilon
        ]
        if (!cropContains(proof.image.rect, box) || cropHit(proof.publishedRect, box)) continue
        if (nonwhite(x, y) && nonwhite(x + 1, y) && nonwhite(x, y + 1) && nonwhite(x + 1, y + 1))
          return proof.current()
      }
    return false
  } finally {
    canvas.width = canvas.height = 0
  }
}

// The clipped-image exception never weakens the ordinary AA test. It must
// reproduce the complete native image, the normal PDF crop and the exact-image
// clip byte for byte at the actual byte-budget-selected resolution.
export async function nativeIsolatedRasterImagePng(plan, nativePage, rect, rotation) {
  try {
    const proof = isolatedCrops.get(plan)
    if (
      !proof ||
      !proof.current() ||
      !equal(rect, plan.rect) ||
      (proof.live && proof.live.nativePage !== nativePage)
    )
      return
    if (rotation === undefined) rotation = proof.rotation
    if (rotation !== proof.rotation) return
    const live = proof.live,
      seal = async (png) => {
        if (proof.needsOwnPaintWitness && !(await ownRasterPaintOutsidePublished(proof, png, rect)))
          return
        if (!proof.current()) return
        proof.ownPaintProven = true
        if (proof.live) proof.canonical = Buffer.from(png)
        return nativeIsolatedOpaqueRasterPngSafe(plan, png, rect, proof.page) ? png : undefined
      },
      adapter = (imageOnly = false) => ({
        rotate: rotation,
        getViewport: (options) => nativePage.getViewport(options),
        render: (options) => {
          const task = nativePage.render(
              imageOnly
                ? {
                    ...options,
                    operationsFilter: (i) => {
                      const op = live.operators.fnArray[i]
                      return (
                        op !== OPS.showText &&
                        (op !== OPS.paintImageXObject || i === proof.image.operationIndex)
                      )
                    }
                  }
                : options
            ),
            promise = task.promise.then((value) => {
              if (!proof.current() || !live.bindDisplay(task._internalRenderTask?.operatorList))
                throw new Error('Native raster display changed.')
              return value
            })
          return { promise }
        }
      }),
      normal = await renderPdfCrop(live ? adapter() : nativePage, rect, rotation)
    if (!proof.current()) return
    if (isolatedRasterPngSafe(plan, normal, rect, proof.page, true)) {
      return await seal(normal)
    }
    if (!proof.live || !proof.image || !proof.clipProgram) return
    const image = proof.image,
      masked = await renderPdfCrop(adapter(), rect, rotation, [image.rect])
    if (!proof.current() || !normal.equals(masked)) return
    const imageOnly = await renderPdfCrop(adapter(true), rect, rotation)
    if (!proof.current() || !normal.equals(imageOnly)) return
    return await seal(normal)
  } catch {
    return
  }
}

export function nativeIsolatedRasterCropMetadata(plan, png, rect, page) {
  const proof = isolatedCrops.get(plan)
  return proof?.missing && nativeIsolatedOpaqueRasterPngSafe(plan, png, rect, page)
    ? { graphicsCount: 1, resolvedIssue: 'ambiguous-graphic-direction' }
    : undefined
}
export function nativeOpaqueRasterCrop(page, figure, captions, tables, context) {
  try {
    const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite),
      valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3],
      eq = (a, b) => JSON.stringify(a) === JSON.stringify(b),
      same = (a, b) =>
        Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 16,
      over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      lineRect = (l) => [l.x, l.y, l.x + l.width, l.y + l.height]
    const o = context?.operators,
      v = context?.viewport,
      raw = context?.content?.items,
      recorded = context?.graphicsBounds
    if (
      !valid(figure?.rect) ||
      figure.parts !== undefined ||
      figure.cropRects !== undefined ||
      figure.sourceItems?.length ||
      !valid(figure.caption?.rect) ||
      figure.caption.page !== page.pageNumber ||
      page.invalidGraphicsBounds !== 0 ||
      ![
        captions,
        tables,
        raw,
        recorded,
        page.lines,
        context?.opaqueRasterImages,
        o?.fnArray,
        o?.argsArray
      ].every(Array.isArray) ||
      o.fnArray.length !== o.argsArray.length ||
      o.fnArray.length > 100000 ||
      v?.rotation !== 0 ||
      v.scale !== 1 ||
      v.width !== page.width ||
      v.height !== page.height ||
      !eq(v.transform, [1, 0, 0, -1, 0, page.height]) ||
      !eq(recorded, page.graphicsBounds)
    )
      return
    const permitted = new Set(
      [
        'beginMarkedContentProps',
        'beginMarkedContent',
        'endMarkedContent',
        'save',
        'restore',
        'transform',
        'eoClip',
        'clip',
        'constructPath',
        'beginText',
        'endText',
        'dependency',
        'setFont',
        'setTextMatrix',
        'moveText',
        'showText',
        'setGState',
        'setFillRGBColor',
        'setStrokeRGBColor',
        'setCharSpacing',
        'paintImageXObject',
        'paintFormXObjectBegin',
        'paintFormXObjectEnd'
      ].map((k) => OPS[k])
    )
    let depth = 0,
      forms = 0,
      lastPaint = -1,
      font
    const fontStack = [],
      painted = []
    for (let n = 0; n < o.fnArray.length; n++) {
      const op = o.fnArray[n],
        a = o.argsArray[n]
      if (!permitted.has(op)) return
      if (op === OPS.save) depth++
      if (op === OPS.restore && --depth < 0) return
      if (op === OPS.paintFormXObjectBegin) forms++
      if (op === OPS.paintFormXObjectEnd && --forms < 0) return
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) fontStack.push(font)
      if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!fontStack.length) return
        font = fontStack.pop()
      }
      if (op === OPS.setFont) {
        if (typeof a?.[0] !== 'string' || !Number.isFinite(a[1]) || a[1] <= 0) return
        font = a[0]
      }
      if (op === OPS.showText) {
        if (!font || !Array.isArray(a?.[0])) return
        for (const g of a[0]) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) return
            continue
          }
          if (
            typeof g?.unicode !== 'string' ||
            !g.unicode ||
            g.accent != null ||
            [...g.unicode].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
          )
            return
          if (!g.unicode.trim()) {
            const absent =
              g.originalCharCode === 32 &&
              g.fontChar === ' ' &&
              g.unicode === ' ' &&
              g.isSpace === true &&
              g.isInFont === false
            const fs = context.glyphBounds?.filter((f) => f.fontName === font),
              gs =
                fs?.length === 1
                  ? fs[0].glyphs?.filter((p) => p.fontChar === g.fontChar)
                  : undefined
            if (
              !absent &&
              (gs?.length !== 1 ||
                !finite(gs[0].bounds, 4) ||
                (gs[0].bounds[2] > gs[0].bounds[0] && gs[0].bounds[3] > gs[0].bounds[1]))
            )
              return
          } else for (const c of g.unicode) if (c.trim()) painted.push([c, font])
        }
      }
      if (
        op === OPS.setGState &&
        (!Array.isArray(a?.[0]) ||
          a[0].some(
            (s) =>
              !Array.isArray(s) ||
              s.length !== 2 ||
              (!(['ca', 'CA'].includes(s[0]) && s[1] === 1) &&
                !(s[0] === 'SMask' && s[1] === false) &&
                !(s[0] === 'BM' && s[1] === 'source-over'))
          ))
      )
        return
      if (op === OPS.constructPath && (a?.[0] !== OPS.endPath || !a[1]?.length)) return
      if (op === OPS.paintImageXObject || op === OPS.showText) lastPaint = n
    }
    if (
      depth ||
      forms ||
      fontStack.length ||
      o.fnArray[lastPaint] !== OPS.paintImageXObject ||
      !eq(
        painted,
        raw.flatMap((r) =>
          typeof r?.str === 'string'
            ? [...r.str].filter((c) => c.trim()).map((c) => [c, r.fontName])
            : []
        )
      )
    )
      return
    const opaque = context.opaqueRasterImages.filter((i) => i?.operationIndex === lastPaint),
      a = o.argsArray[lastPaint]
    if (
      opaque.length !== 1 ||
      opaque[0].kind !== 2 ||
      opaque[0].imageId !== a?.[0] ||
      opaque[0].width !== a[1] ||
      opaque[0].height !== a[2]
    )
      return
    // The last raster is painted directly in page coordinates, under one exact
    // rectangular clip, not an inherited Form or a partially known path.
    const start = lastPaint - 5
    if (
      !eq(o.fnArray.slice(start, lastPaint + 2), [
        OPS.save,
        OPS.eoClip,
        OPS.constructPath,
        OPS.transform,
        OPS.dependency,
        OPS.paintImageXObject,
        OPS.restore
      ])
    )
      return
    if (
      o.fnArray.slice(0, start).filter((x) => x === OPS.save).length !==
        o.fnArray.slice(0, start).filter((x) => x === OPS.restore).length ||
      o.fnArray.slice(0, start).filter((x) => x === OPS.paintFormXObjectBegin).length !==
        o.fnArray.slice(0, start).filter((x) => x === OPS.paintFormXObjectEnd).length
    )
      return
    // Every earlier page transform is inside a balanced saved graphics state.
    let d = 0
    for (let n = 0; n < start; n++) {
      if (o.fnArray[n] === OPS.save || o.fnArray[n] === OPS.paintFormXObjectBegin) d++
      if (o.fnArray[n] === OPS.restore || o.fnArray[n] === OPS.paintFormXObjectEnd) d--
      if (
        d < 0 ||
        ([OPS.transform, OPS.clip, OPS.eoClip, OPS.constructPath].includes(o.fnArray[n]) && d === 0)
      )
        return
    }
    if (d) return
    const path = Array.from(o.argsArray[start + 2]?.[1]?.[0] ?? []),
      m = o.argsArray[start + 3]
    if (
      path.length !== 13 ||
      !path.every(Number.isFinite) ||
      path[0] !== 0 ||
      path[3] !== 1 ||
      path[6] !== 1 ||
      path[9] !== 1 ||
      path[12] !== 4 ||
      path[2] !== path[5] ||
      path[4] !== path[7] ||
      path[8] !== path[11] ||
      path[10] !== path[1] ||
      path[1] >= path[4] ||
      path[2] >= path[8] ||
      !finite(m, 6) ||
      m[1] ||
      m[2] ||
      m[0] <= 0 ||
      m[3] <= 0
    )
      return
    const clip = [path[1], page.height - path[8], path[4], page.height - path[2]],
      image = [m[4], page.height - m[5] - m[3], m[4] + m[0], page.height - m[5]],
      crop = [
        Math.max(clip[0], image[0]),
        Math.max(clip[1], image[1]),
        Math.min(clip[2], image[2]),
        Math.min(clip[3], image[3])
      ]
    if (
      !valid(crop) ||
      !over(crop, figure.rect) ||
      crop[1] <= figure.rect[1] ||
      crop[3] >= figure.caption.rect[3] ||
      tables.some((t) => !valid(t) || over(t, crop))
    )
      return
    const e = { images: [], paths: new Map(), texts: new Map(), frames: new Map() }
    collectClosedFigureFrames(o, v, e)
    const im = e.images.filter((i) => i.operationIndex === lastPaint)
    if (
      im.length !== 1 ||
      !eq(im[0].rect, crop) ||
      recorded.length !== e.images.length ||
      new Set(recorded.map((i) => i.operationIndex)).size !== recorded.length ||
      recorded.some(
        (g) =>
          g.kind !== 'image' ||
          !valid(g.normalizedRect) ||
          e.images.filter((i) => i.operationIndex === g.operationIndex).length !== 1
      )
    )
      return
    const carrier = recorded
      .find((g) => g.operationIndex === lastPaint)
      ?.normalizedRect?.map((n, i) => n * (i % 2 ? page.height : page.width))
    if (!valid(carrier) || crop.some((n, i) => (i < 2 ? n < carrier[i] : n > carrier[i]))) return
    const envelope = [
      Math.min(crop[0], figure.rect[0]),
      Math.min(crop[1], figure.rect[1]),
      Math.max(crop[2], figure.rect[2]),
      Math.max(crop[3], figure.rect[3])
    ]
    if (
      recorded.some(
        (g) =>
          g.operationIndex !== lastPaint &&
          over(
            g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width)),
            envelope
          )
      )
    )
      return
    const cap = figure.caption,
      capLines = page.lines.filter(
        (l) => cap.lines?.includes(l.text) && over(lineRect(l), cap.rect)
      )
    if (
      capLines.length !== cap.lines?.length ||
      captions.some((c) => !eq(c, cap) && c.page === page.pageNumber && over(c.rect, envelope))
    )
      return
    const removed = page.lines.filter(
      (l) => over(lineRect(l), figure.rect) && !over(lineRect(l), crop)
    )
    if (removed.length !== 1) return
    const tail = removed[0],
      peers = page.lines
        .filter(
          (l) =>
            l.y < tail.y &&
            l.x === tail.x &&
            l.fontSize === tail.fontSize &&
            l.height === tail.height &&
            l.width > tail.width
        )
        .sort((a, b) => b.y - a.y)
        .slice(0, 2)
    if (
      peers.length !== 2 ||
      !Array.isArray(figure.excludedProseLines) ||
      peers.some((l) => !figure.excludedProseLines.some((e) => eq(e, l))) ||
      !same(tail.y + peers[1].y, 2 * peers[0].y) ||
      tail.y + tail.height >= crop[1] ||
      crop[1] - (tail.y + tail.height) >= tail.y - peers[0].y ||
      peers.some((l) => l.x < crop[0] || l.x + l.width > crop[2]) ||
      tail.x < crop[0] ||
      tail.x + tail.width > crop[2]
    )
      return
    const packet = [peers[1], peers[0], tail, ...capLines],
      owned = new Set(),
      captionFonts = new Set()
    for (let index = 0; index < raw.length; index++) {
      const r = raw[index]
      if (typeof r?.str !== 'string') return
      if (!r.str.trim()) continue
      if (
        r.sourceItem?.pageNumber !== page.pageNumber ||
        r.sourceItem.index !== index ||
        r.sourceItem.text !== r.str ||
        ['sourceItems', 'sourceToken', 'sourceSegments', 'sourceSegment'].some(
          (k) => r[k] != null
        ) ||
        !finite(r.transform, 6) ||
        r.transform[1] ||
        r.transform[2] ||
        r.transform[0] <= 0 ||
        r.transform[0] !== r.transform[3] ||
        r.dir !== 'ltr' ||
        !Number.isFinite(r.width) ||
        r.width <= 0 ||
        r.height !== r.transform[0] ||
        context.content.styles?.[r.fontName]?.vertical !== false
      )
        return
    }
    for (const l of packet) {
      const fonts = raw.filter(
        (r) =>
          r.str.trim() &&
          same(page.height - r.transform[5], l.y + l.height) &&
          r.height === l.fontSize &&
          r.transform[4] >= l.x &&
          r.transform[4] + r.width <=
            l.x + l.width + Number.EPSILON * Math.max(1, l.x + l.width) * 16
      )
      if (
        !fonts.length ||
        fonts.some((r) => owned.has(r)) ||
        fonts
          .map((r) => r.str)
          .join('')
          .replace(/\s/gu, '') !== l.text.replace(/\s/gu, '') ||
        !same(Math.min(...fonts.map((r) => r.transform[4])), l.x) ||
        !same(Math.max(...fonts.map((r) => r.transform[4] + r.width)), l.x + l.width)
      )
        return
      fonts.forEach((r) => {
        owned.add(r)
        if (capLines.includes(l)) captionFonts.add(r)
      })
    }
    const above = [crop[0], figure.rect[1], crop[2], crop[1]]
    if (
      raw.some(
        (r) =>
          r.str.trim() &&
          !owned.has(r) &&
          over(
            [
              r.transform[4],
              page.height - r.transform[5] - r.height,
              r.transform[4] + r.width,
              page.height - r.transform[5]
            ],
            above
          )
      )
    )
      return
    if (!captionGlyphInkOutside(context, e, captionFonts, crop)) return
    return crop
  } catch {
    return
  }
}

function captionGlyphInkOutside(context, evidence, captionFonts, crop) {
  const o = context.operators,
    v = context.viewport,
    positions = new Set(),
    stack = []
  let offset = 0,
    at = 0,
    state = { font: undefined, size: 0, spacing: 0 },
    tm = [1, 0, 0, 1, 0, 0],
    x = 0,
    y = 0,
    lx = 0,
    ly = 0,
    proved = 0
  for (const r of context.content.items)
    for (const c of r.str)
      if (c.trim()) {
        if (captionFonts.has(r)) positions.add(offset)
        offset++
      }
  for (let n = 0; n < o.fnArray.length; n++) {
    const op = o.fnArray[n],
      a = o.argsArray[n]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ ...state })
    if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return false
      state = stack.pop()
    }
    if (op === OPS.beginText) {
      tm = [1, 0, 0, 1, 0, 0]
      x = y = lx = ly = 0
    }
    if (op === OPS.setTextMatrix) {
      tm = Array.from(a?.[0] ?? [])
      if (tm.length !== 6 || !tm.every(Number.isFinite)) return false
      x = y = lx = ly = 0
    }
    if (op === OPS.moveText) {
      if (!Array.isArray(a) || a.length !== 2 || !a.every(Number.isFinite)) return false
      x = lx += a[0]
      y = ly += a[1]
    }
    if (op === OPS.setFont) {
      state.font = a[0]
      state.size = a[1]
    }
    if (op === OPS.setCharSpacing) {
      if (!Number.isFinite(a?.[0])) return false
      state.spacing = a[0]
    }
    if (op !== OPS.showText) continue
    for (const g of a[0]) {
      if (typeof g === 'number') {
        x -= (g * state.size) / 1000
        continue
      }
      const chars = [...g.unicode].filter((c) => c.trim()),
        wanted = chars.some((_, i) => positions.has(at + i))
      if (wanted) {
        if (chars.some((_, i) => !positions.has(at + i))) return false
        const fonts = context.glyphBounds?.filter((f) => f.fontName === state.font),
          paths =
            fonts?.length === 1
              ? fonts[0].glyphs?.filter((p) => p.fontChar === g.fontChar)
              : undefined,
          paint = evidence.texts.get(n)
        if (
          paths?.length !== 1 ||
          !Array.isArray(paths[0].bounds) ||
          paths[0].bounds.length !== 4 ||
          !paths[0].bounds.every(Number.isFinite) ||
          !paint?.transform ||
          !paint.clip
        )
          return false
        const b = paths[0].bounds,
          m = Util.transform(v.transform, Util.transform(paint.transform, tm))
        if (b[0] >= b[2] || b[1] >= b[3] || m[1] || m[2] || m[0] <= 0 || m[3] >= 0) return false
        const left = [x + b[0] * state.size, y + b[3] * state.size],
          right = [x + b[2] * state.size, y + b[1] * state.size]
        Util.applyTransform(left, m)
        Util.applyTransform(right, m)
        const r = [...left, ...right]
        if (
          !r.every(Number.isFinite) ||
          r[0] >= r[2] ||
          r[1] >= r[3] ||
          r[1] < crop[3] ||
          r.some((z, i) => (i < 2 ? z < paint.clip[i] : z > paint.clip[i]))
        )
          return false
        proved += chars.length
      }
      at += chars.length
      if (!Number.isFinite(g.width) || g.width < 0) return false
      x += (g.width * state.size) / 1000 + state.spacing
    }
  }
  return !stack.length && proved > 0 && proved === positions.size && at === offset
}
