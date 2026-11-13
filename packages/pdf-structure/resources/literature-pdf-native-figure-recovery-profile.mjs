/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeIsolatedRasterScopeData } from './literature-pdf-isolated-raster-scope.mjs'
import { compactNativePixelTupleBindings } from './literature-pdf-native-compact-bindings.mjs'
import { compactNativePixelArrayBindings } from './literature-pdf-native-compact-array-bindings.mjs'

const profiles = new WeakMap(),
  paintProfiles = new WeakMap(),
  nonisolatedGroupProfiles = new WeakMap(),
  nonisolatedExclusionProfiles = new WeakMap(),
  compositeGroupProfiles = new WeakMap()
const digest = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex')

// Retain actual input objects as well as values. No getter is executed while
// walking native snapshots; an own accessor declines this optional contract.
function retainReferences(roots, viewport, secondaryViewport, compact) {
  const seen = new Set(),
    bindings = []
  // A pixel-only caller can bind one additional actual native viewport. Keep
  // its full prototype/callback descriptors; never replace it with plain data.
  if (secondaryViewport !== undefined) {
    if (
      !secondaryViewport ||
      typeof secondaryViewport !== 'object' ||
      types.isProxy(secondaryViewport)
    )
      return
    const prototype = Object.getPrototypeOf(secondaryViewport)
    if (prototype && types.isProxy(prototype)) return
    if (prototype && prototype !== Object.prototype && prototype !== Array.prototype) {
      const parent = Object.getPrototypeOf(prototype),
        descriptors = Object.getOwnPropertyDescriptors(prototype),
        keys = Reflect.ownKeys(descriptors)
      bindings.push(
        () =>
          Object.getPrototypeOf(prototype) === parent &&
          Reflect.ownKeys(prototype).length === keys.length &&
          Reflect.ownKeys(prototype).every((key, i) => key === keys[i]) &&
          keys.every((key) => {
            const d = Object.getOwnPropertyDescriptor(prototype, key),
              old = descriptors[key]
            return (
              d &&
              d.enumerable === old.enumerable &&
              d.configurable === old.configurable &&
              Object.hasOwn(d, 'value') === Object.hasOwn(old, 'value') &&
              (Object.hasOwn(old, 'value')
                ? Object.is(d.value, old.value) && d.writable === old.writable
                : d.get === old.get && d.set === old.set)
            )
          })
      )
    }
  }
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return true
    if (types.isProxy(value)) return false
    if (compact?.contains(value)) return true
    if (seen.size >= 65536) return false
    seen.add(value)
    if (ArrayBuffer.isView(value)) {
      const prototype = Object.getPrototypeOf(value),
        keys = Object.getOwnPropertyNames(value)
      if (
        ![
          Int8Array,
          Uint8Array,
          Uint8ClampedArray,
          Int16Array,
          Uint16Array,
          Int32Array,
          Uint32Array,
          Float32Array,
          Float64Array
        ].some((type) => prototype === type.prototype) ||
        keys.some((key, index) => key !== String(index))
      )
        return false
      const count = keys.length,
        buffer = value.buffer,
        offset = value.byteOffset,
        length = value.byteLength,
        initial = createHash('sha256')
          .update(new Uint8Array(buffer, offset, length))
          .digest('hex')
      bindings.push(
        () =>
          Object.getPrototypeOf(value) === prototype &&
          Object.getOwnPropertyNames(value).length === count &&
          value.buffer === buffer &&
          value.byteOffset === offset &&
          value.byteLength === length &&
          createHash('sha256')
            .update(new Uint8Array(buffer, offset, length))
            .digest('hex') === initial
      )
      return true
    }
    const prototype = Object.getPrototypeOf(value),
      descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(descriptors)
    if (
      value !== viewport &&
      value !== secondaryViewport &&
      prototype !== Object.prototype &&
      prototype !== null &&
      prototype !== Array.prototype
    )
      return false
    if (keys.some((key) => !Object.hasOwn(descriptors[key], 'value'))) return false
    bindings.push(
      () =>
        Object.getPrototypeOf(value) === prototype &&
        Reflect.ownKeys(value).length === keys.length &&
        Reflect.ownKeys(value).every((key, index) => key === keys[index]) &&
        keys.every((key) => {
          const d = Object.getOwnPropertyDescriptor(value, key),
            old = descriptors[key]
          return (
            d &&
            Object.hasOwn(d, 'value') &&
            Object.is(d.value, old.value) &&
            d.enumerable === old.enumerable &&
            d.configurable === old.configurable &&
            d.writable === old.writable
          )
        })
    )
    return keys.every((key) => visit(descriptors[key].value))
  }
  if (!roots.every(visit) || (secondaryViewport !== undefined && !seen.has(secondaryViewport)))
    return
  return () => (!compact || compact.current()) && bindings.every((same) => same())
}

function nestedOrdinaryGroups(o) {
  const groups = [],
    stack = []
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.beginGroup) {
      const g = a?.[0]
      if (
        !g ||
        Object.keys(g).sort().join(',') !== 'bbox,isolated,knockout,matrix,smask' ||
        g.matrix !== null ||
        g.smask !== null ||
        g.isolated !== true ||
        g.knockout !== false ||
        !Array.isArray(g.bbox) ||
        g.bbox.length !== 4 ||
        !g.bbox.every(Number.isFinite) ||
        g.bbox[0] >= g.bbox[2] ||
        g.bbox[1] >= g.bbox[3] ||
        stack.length >= 4 ||
        groups.length >= 64
      )
        return
      const row = { begin: i, depth: stack.length, args: g }
      groups.push(row)
      stack.push(row)
    } else if (op === OPS.endGroup) {
      const row = stack.pop()
      if (!row || JSON.stringify(row.args) !== JSON.stringify(a?.[0])) return
      row.end = i
    } else if (op === OPS.setGState) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some(
          (e) =>
            !Array.isArray(e) ||
            e.length !== 2 ||
            !(
              (['CA', 'ca'].includes(e[0]) && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1) ||
              (e[0] === 'SMask' && e[1] === false) ||
              (e[0] === 'BM' && e[1] === 'source-over')
            )
        )
      )
        return
    } else if ([OPS.setFillColorN, OPS.setStrokeColorN, OPS.shadingFill].includes(op)) return
  }
  if (stack.length || !groups.some((g) => g.depth > 0)) return
  return groups
}

// Crop-only proof for a single root transparency group whose complete bounded
// canvas has no prior page paint or text to contribute to nonisolated blending.
// This lives in a separate weak map so it cannot activate ordinary Source/ink
// ownership contracts.
function nonisolatedCropGroup(page, context, disjointBackdrop = false) {
  const o = context?.operators,
    bounds = context?.graphicsBounds
  if (!Array.isArray(bounds) || !Array.isArray(o?.fnArray)) return
  const groups = [],
    stack = []
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.beginGroup) {
      const g = a?.[0]
      if (
        !g ||
        Object.keys(g).sort().join(',') !== 'bbox,isolated,knockout,matrix,smask' ||
        g.matrix !== null ||
        g.smask !== null ||
        g.isolated !== false ||
        g.knockout !== false ||
        !Array.isArray(g.bbox) ||
        g.bbox.length !== 4 ||
        !g.bbox.every(Number.isFinite) ||
        g.bbox[0] >= g.bbox[2] ||
        g.bbox[1] >= g.bbox[3] ||
        stack.length ||
        groups.length
      )
        return
      const row = { begin: i, depth: 0, args: g }
      groups.push(row)
      stack.push(row)
    } else if (op === OPS.endGroup) {
      const row = stack.pop()
      if (!row || JSON.stringify(row.args) !== JSON.stringify(a?.[0])) return
      row.end = i
    }
  }
  if (stack.length || groups.length !== 1 || !Number.isInteger(groups[0].end)) return
  const { begin, end, args } = groups[0]
  if (
    bounds.some(
      (g) => !Number.isInteger(g.operationIndex) || (!disjointBackdrop && g.operationIndex < begin)
    ) ||
    !page ||
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height)
  )
    return
  return [
    Object.freeze({
      begin,
      end,
      depth: 0,
      bbox: Object.freeze([...args.bbox]),
      isolated: false,
      knockout: false,
      matrix: null,
      smask: null,
      backdrop: Object.freeze(
        disjointBackdrop
          ? {
              priorPaintRequiresIndependentDisjointProof: true,
              glyphsRequireIndependentDisjointProof: true
            }
          : { priorPaint: false, glyphsRequireIndependentDisjointProof: true }
      )
    })
  ]
}

function inertTextOperations(o) {
  const neutral = new Set()
  let inText = false,
    leading = 0
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.beginText) {
      if (inText) return
      inText = true
    } else if (op === OPS.endText) {
      if (!inText) return
      inText = false
    } else if (op === OPS.setLeading) {
      if (!inText || !Array.isArray(a) || a.length !== 1 || !Number.isFinite(a[0])) return
      neutral.add(i)
      leading++
    } else if (
      [
        OPS.nextLine,
        OPS.nextLineShowText,
        OPS.nextLineSetSpacingShowText,
        OPS.setLeadingMoveText
      ].includes(op)
    ) {
      if (!inText || op !== OPS.nextLine || o.fnArray[i + 1] !== OPS.endText || a !== null) return
      neutral.add(i)
    }
  }
  if (inText || !leading) return
  return neutral
}

function foreignCompoundAccents(context, o) {
  const evidence = context.foreignCompoundGlyphs
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > 64) return
  const fonts = new Map(),
    used = new Map(),
    result = new Map(),
    stack = []
  for (const f of evidence) {
    if (
      !f ||
      Object.keys(f).sort().join(',') !==
        'disableFontFace,fontMatrix,fontName,glyphs,isType3Font,missingFile,remeasure' ||
      typeof f.fontName !== 'string' ||
      fonts.has(f.fontName) ||
      f.missingFile !== false ||
      f.disableFontFace !== true ||
      f.remeasure !== false ||
      f.isType3Font !== false ||
      JSON.stringify(f.fontMatrix) !== JSON.stringify([0.001, 0, 0, 0.001, 0, 0]) ||
      !Array.isArray(f.glyphs) ||
      !f.glyphs.length ||
      f.glyphs.length > 1024
    )
      return
    const glyphs = new Map()
    for (const g of f.glyphs) {
      if (
        !g ||
        Object.keys(g).sort().join(',') !== 'bounds,fontChar' ||
        typeof g.fontChar !== 'string' ||
        !g.fontChar ||
        glyphs.has(g.fontChar) ||
        !Array.isArray(g.bounds) ||
        g.bounds.length !== 4 ||
        !g.bounds.every(Number.isFinite) ||
        g.bounds[0] >= g.bounds[2] ||
        g.bounds[1] >= g.bounds[3]
      )
        return
      glyphs.set(g.fontChar, Object.freeze([...g.bounds]))
    }
    fonts.set(f.fontName, glyphs)
    used.set(f.fontName, new Set())
  }
  let active
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.setFont) active = a?.[0]
    else if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) stack.push(active)
    else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
      if (!stack.length) return
      active = stack.pop()
    } else if (op === OPS.showText)
      for (const [glyphIndex, g] of (a?.[0] ?? []).entries()) {
        if (typeof g !== 'object' || g?.accent == null) continue
        const accent = g.accent,
          bounds = fonts.get(active)?.get(accent?.fontChar)
        if (
          !bounds ||
          g.isInFont !== true ||
          g.isSpace === true ||
          !/\S/u.test(g.unicode ?? '') ||
          Array.from(g.unicode ?? '').length !== 1 ||
          Object.keys(accent).sort().join(',') !== 'fontChar,offset' ||
          !accent.offset ||
          Object.keys(accent.offset).sort().join(',') !== 'x,y' ||
          !Number.isFinite(accent.offset.x) ||
          !Number.isFinite(accent.offset.y)
        )
          return
        used.get(active).add(accent.fontChar)
        result.set(i + ':' + glyphIndex, {
          glyph: g,
          fontName: active,
          evidence: Object.freeze({
            fontChar: accent.fontChar,
            bounds,
            offset: Object.freeze({ x: accent.offset.x, y: accent.offset.y })
          })
        })
      }
  }
  if (
    stack.length ||
    !result.size ||
    [...fonts].some(([name, glyphs]) => glyphs.size !== used.get(name).size)
  )
    return
  return result
}

function compoundSubscriptSources(context, o) {
  const visible = [],
    stack = [],
    indices = new Set()
  let fontName,
    size,
    matrix = [1, 0, 0, 1, 0, 0]
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.setFont) [fontName, size] = a
    else if (op === OPS.beginText) matrix = [1, 0, 0, 1, 0, 0]
    else if (op === OPS.setTextMatrix) {
      if (
        !(Array.isArray(a?.[0]) || ArrayBuffer.isView(a?.[0])) ||
        a[0].length !== 6 ||
        !Array.from(a[0]).every(Number.isFinite)
      )
        return
      matrix = Array.from(a[0])
    } else if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op))
      stack.push([fontName, size])
    else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
      if (!stack.length) return
      ;[fontName, size] = stack.pop()
    } else if (op === OPS.showText)
      for (const glyph of a?.[0] ?? []) {
        if (typeof glyph === 'number') continue
        if (typeof glyph?.unicode !== 'string') return
        for (const c of Array.from(glyph.unicode.normalize('NFD')).filter((c) => !/\s/u.test(c))) {
          if (visible.length >= 100000) return
          visible.push({ c, glyph, i, fontName, size: size * Math.hypot(matrix[0], matrix[1]) })
        }
      }
  }
  if (stack.length || !Array.isArray(context.content?.items) || context.content.items.length > 4096)
    return
  let offset = 0
  for (const [index, r] of context.content.items.entries()) {
    if (typeof r.str !== 'string') return
    const chars = Array.from(r.str.normalize('NFD')).filter((c) => !/\s/u.test(c)),
      part = visible.slice(offset, offset + chars.length)
    offset += chars.length
    if (
      part.map((z) => z.c).join('') !== chars.join('') ||
      part.some((z) => z.fontName !== r.fontName)
    )
      return
    if (
      part.length === 2 &&
      part[0].glyph !== part[1].glyph &&
      part[0].i < part[1].i &&
      part[1].size > 0 &&
      part[1].size < part[0].size
    )
      indices.add(index)
  }
  return offset === visible.length && indices.size ? indices : undefined
}

function compoundSubscriptAdvance(r, part, rect, q) {
  const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.02
  if (
    part.length !== 2 ||
    part[0].g === part[1].g ||
    part.some((z) => Array.from(z.g.text).length !== 1) ||
    part.map((z) => z.c).join('') !== r.str ||
    part.some((z) => z.g.fontName !== r.fontName) ||
    part[0].g.i >= part[1].g.i ||
    !Array.isArray(r.transform) ||
    r.transform.length !== 6 ||
    r.transform[0] <= 0 ||
    r.transform[0] !== r.transform[3] ||
    r.transform[1] !== 0 ||
    r.transform[2] !== 0 ||
    r.height !== r.transform[3]
  )
    return false
  const [a, b] = part.map((z) => z.g.advance),
    height = a[3] - a[1],
    script = b[3] - b[1]
  return (
    close(a[0], rect[0]) &&
    close(a[1], rect[1]) &&
    close(a[3], rect[3]) &&
    close(height, r.height) &&
    script > 0 &&
    script < height &&
    b[1] > a[1] &&
    b[1] < a[3] &&
    b[3] > a[3] &&
    close(a[2], b[0]) &&
    close(b[2], rect[2]) &&
    close(q[0], rect[0]) &&
    close(q[1], rect[1]) &&
    close(q[2], rect[2]) &&
    close(r.width, q[2] - q[0])
  )
}

function createRecoveryProfile(page, tokens, context, purpose) {
  try {
    if (
      !page ||
      !context ||
      [
        'operators',
        'viewport',
        'content',
        'glyphBounds',
        'graphicsBounds',
        'sourceSha256',
        'pageNumber'
      ].some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(context, key) ?? {}, 'value'))
    )
      return
    const o = context.operators,
      v = context.viewport
    if (
      !v ||
      ['width', 'height', 'rotation', 'scale', 'transform'].some(
        (key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(v, key) ?? {}, 'value')
      )
    )
      return
    const roots = [page, tokens, context],
      unchanged = retainReferences(roots, v),
      converter = viewportConverter(v)
    if (!unchanged || !converter) return
    if (
      !Array.isArray(context.glyphBounds) ||
      context.glyphBounds.some(
        (font) =>
          !Array.isArray(font?.glyphs) ||
          (font.glyphs.length > 0 && context.content?.styles?.[font.fontName]?.vertical !== false)
      )
    )
      return
    if (
      !page ||
      page.pageNumber !== context?.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context?.sourceSha256 ?? '') ||
      page.invalidGraphicsBounds !== 0 ||
      page.rotation !== 0 ||
      !Array.isArray(tokens) ||
      !Array.isArray(o?.fnArray) ||
      o.fnArray.length !== o.argsArray?.length ||
      o.fnArray.length > 100000 ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height
    )
      return
    const nested = purpose === 'figure' ? nestedOrdinaryGroups(o) : undefined,
      inertText = purpose === 'figure' ? inertTextOperations(o) : undefined,
      accents = foreignCompoundAccents(context, o),
      compoundSources = purpose === 'figure' ? compoundSubscriptSources(context, o) : undefined
    const rasterScope =
      purpose === 'isolated-raster' ? nativeIsolatedRasterScopeData(page, context) : undefined
    if (!nested && !inertText && !accents && !compoundSources && !rasterScope) return
    const initial = digest(roots),
      profile = Object.freeze({})
    profiles.set(
      profile,
      Object.freeze({
        rasterScope,
        rasterOperation: (i) => rasterScope?.ordinaryOperations.includes(i) === true,
        page,
        tokens,
        context,
        nested:
          nested &&
          Object.freeze(
            nested.map(({ begin, end, depth }) => Object.freeze({ begin, end, depth }))
          ),
        inertText: !!inertText,
        inertTextOperation: (i) => inertText?.has(i) === true,
        accentGlyph: (key, fontName, glyph) => {
          const entry = accents?.get(key)
          return entry?.fontName === fontName && entry.glyph === glyph ? entry.evidence : undefined
        },
        compoundSourceAdvance: (index, r, part, rect, q) =>
          compoundSources?.has(index) === true && compoundSubscriptAdvance(r, part, rect, q),
        unchanged,
        initial,
        converter
      })
    )
    return profile
  } catch {
    return
  }
}
function viewportConverter(viewport) {
  for (
    let object = viewport, depth = 0;
    object && depth < 2;
    object = Object.getPrototypeOf(object), depth++
  ) {
    const d = Object.getOwnPropertyDescriptor(object, 'convertToViewportPoint')
    if (d) return Object.hasOwn(d, 'value') && typeof d.value === 'function' ? d.value : undefined
  }
}
export function createNativeFigureRecoveryProfile(page, tokens, context) {
  return createRecoveryProfile(page, tokens, context, 'figure')
}
function compositeCropGroup(context) {
  const o = context?.operators,
    bounds = context?.graphicsBounds,
    stack = [],
    nodes = []
  if (!Array.isArray(bounds) || !Array.isArray(o?.fnArray)) return
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.beginGroup) {
      const g = a?.[0],
        depth = stack.length
      if (
        !g ||
        Object.keys(g).sort().join(',') !== 'bbox,isolated,knockout,matrix,smask' ||
        g.smask !== null ||
        g.knockout !== false ||
        !Array.isArray(g.bbox) ||
        g.bbox.length !== 4 ||
        !g.bbox.every(Number.isFinite) ||
        g.bbox[0] >= g.bbox[2] ||
        g.bbox[1] >= g.bbox[3] ||
        depth > 1 ||
        nodes.length >= 5 ||
        (depth === 0
          ? nodes.length || g.isolated !== false || g.matrix !== null
          : g.isolated !== true || JSON.stringify(g.matrix) !== JSON.stringify([1, 0, 0, 1, 0, 0]))
      )
        return
      const node = { begin: i, depth, args: g }
      nodes.push(node)
      stack.push(node)
    } else if (op === OPS.endGroup) {
      const node = stack.pop()
      if (!node || JSON.stringify(node.args) !== JSON.stringify(a?.[0])) return
      node.end = i
    }
  }
  if (
    stack.length ||
    nodes.length < 2 ||
    nodes.length > 5 ||
    !Number.isInteger(nodes[0].end) ||
    bounds.some((g) => !Number.isInteger(g.operationIndex) || g.operationIndex < nodes[0].begin)
  )
    return
  const descriptor = (n) =>
    Object.freeze({
      begin: n.begin,
      end: n.end,
      depth: n.depth,
      bbox: Object.freeze([...n.args.bbox]),
      isolated: n.args.isolated,
      knockout: false,
      matrix: n.args.matrix && Object.freeze([...n.args.matrix]),
      smask: null
    })
  return [
    Object.freeze({
      ...descriptor(nodes[0]),
      children: Object.freeze(nodes.slice(1).map(descriptor)),
      backdrop: Object.freeze({ priorPaint: false, glyphsRequireIndependentDisjointProof: true })
    })
  ]
}

function createNonisolatedGroupCropProfile(
  page,
  tokens,
  context,
  disjointBackdrop,
  composite = false
) {
  const safe = disjointBackdrop || composite
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
    const o = own.operators,
      v = own.viewport,
      groups = composite
        ? compositeCropGroup(context)
        : nonisolatedCropGroup(page, context, disjointBackdrop)
    if (
      !groups ||
      !page ||
      !context ||
      page.pageNumber !== context.pageNumber ||
      page.invalidGraphicsBounds !== 0 ||
      page.rotation !== 0 ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      !Array.isArray(tokens) ||
      !Array.isArray(o?.fnArray) ||
      o.fnArray.length !== o.argsArray?.length ||
      o.fnArray.length > 100000 ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height
    )
      return
    const descriptors = Object.getOwnPropertyDescriptors(context),
      keys = Reflect.ownKeys(descriptors),
      prototype = Object.getPrototypeOf(context),
      contextCurrent = () =>
        Object.getPrototypeOf(context) === prototype &&
        Reflect.ownKeys(context).length === keys.length &&
        Reflect.ownKeys(context).every((key, index) => key === keys[index]) &&
        keys.every((key) => {
          const current = Object.getOwnPropertyDescriptor(context, key),
            before = descriptors[key]
          return (
            current &&
            Object.hasOwn(current, 'value') &&
            current.value === before.value &&
            current.enumerable === before.enumerable &&
            current.configurable === before.configurable &&
            current.writable === before.writable
          )
        }),
      // The running-head certificate is not consumed by this crop purpose.
      // Preserve its opaque identity and descriptors without traversing it.
      observed =
        safe &&
        Object.fromEntries(Object.entries(own).filter(([key]) => key !== 'runningHeadWitness')),
      roots = safe ? [page, tokens, observed] : [page, tokens, context],
      unchanged = safe
        ? retainReferences(roots, own.viewport)
        : retainReferences(roots, own.viewport, witness?.witnessViewport),
      converter = viewportConverter(v)
    if (!unchanged || !converter) return
    const profile = Object.freeze({})
    const store = composite
      ? compositeGroupProfiles
      : disjointBackdrop
        ? nonisolatedExclusionProfiles
        : nonisolatedGroupProfiles
    store.set(
      profile,
      Object.freeze({
        page,
        tokens,
        context,
        groups,
        unchanged,
        initial: digest(roots),
        ...(safe ? { roots, contextCurrent } : {}),
        converter
      })
    )
    return profile
  } catch {
    return
  }
}
export function createNativeNonisolatedGroupCropProfile(page, tokens, context) {
  return createNonisolatedGroupCropProfile(page, tokens, context, false)
}
// Separate preview-only purpose: this descriptor proves group closure, not
// backdrop independence. The crop interpreter must bound every exterior paint.
export function createNativeNonisolatedExclusionCropProfile(page, tokens, context) {
  return createNonisolatedGroupCropProfile(page, tokens, context, true)
}
function nonisolatedGroupProfileData(profile, page, tokens, context, store) {
  try {
    const proof = store.get(profile)
    if (
      !proof ||
      page !== proof.page ||
      tokens !== proof.tokens ||
      context !== proof.context ||
      (proof.contextCurrent && !proof.contextCurrent()) ||
      !proof.unchanged() ||
      viewportConverter(context.viewport) !== proof.converter ||
      digest(proof.roots ?? [page, tokens, context]) !== proof.initial
    )
      return
    return proof.groups
  } catch {
    return
  }
}
export function nativeNonisolatedGroupProfileData(profile, page, tokens, context) {
  return nonisolatedGroupProfileData(profile, page, tokens, context, nonisolatedGroupProfiles)
}
export function nativeNonisolatedExclusionProfileData(profile, page, tokens, context) {
  return nonisolatedGroupProfileData(profile, page, tokens, context, nonisolatedExclusionProfiles)
}
export function createNativeForeignAccentProfile(page, tokens, context) {
  return createRecoveryProfile(page, tokens, context, 'foreign-accents')
}

export function nativeFigureRecoveryProfileData(profile, page, tokens, context) {
  try {
    const proof = profiles.get(profile)
    if (
      !proof ||
      page !== proof.page ||
      tokens !== proof.tokens ||
      context !== proof.context ||
      !proof.unchanged() ||
      (proof.rasterScope && nativeIsolatedRasterScopeData(page, context) !== proof.rasterScope) ||
      viewportConverter(context.viewport) !== proof.converter ||
      digest([page, tokens, context]) !== proof.initial
    )
      return
    return proof
  } catch {
    return
  }
}
export function attachNativeRecoveryPaintProfile(evidence, profile, page, tokens, context) {
  const proof = nativeFigureRecoveryProfileData(profile, page, tokens, context)
  if (proof?.nested) paintProfiles.set(evidence, proof)
}
export function nativeRecoveryGroupDepth(evidence) {
  return paintProfiles.has(evidence) ? 4 : 1
}
export const retainNativeRecoveryInputs = (roots, viewport, secondaryViewport) =>
  retainReferences(roots, viewport, secondaryViewport)

export function retainNativeCompactPixelInputs(roots, viewport, secondaryViewport) {
  const compact = compactNativePixelTupleBindings(roots)
  return compact && retainReferences(roots, viewport, secondaryViewport, compact)
}
// Only the array-bound pixel purpose uses this private storage representation.
// The ordinary retainer still visits every noncompact child with its original
// descriptor, prototype, typed-byte and 65536-object checks.
export function retainNativeArrayPixelInputs(roots, viewport, secondaryViewport) {
  const compact = compactNativePixelArrayBindings(roots)
  return (
    compact &&
    retainReferences([...roots, ...compact.frontier], viewport, secondaryViewport, compact)
  )
}
export function nativeRecoveryOwnValues(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some((key) => !Object.hasOwn(descriptors[key], 'value'))) return
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
  )
}

export function createNativeIsolatedRasterProfile(page, tokens, context) {
  return createRecoveryProfile(page, tokens, context, 'isolated-raster')
}

export function createNativeCompositeGroupCropProfile(page, tokens, context) {
  return createNonisolatedGroupCropProfile(page, tokens, context, false, true)
}
export function nativeCompositeGroupProfileData(profile, page, tokens, context) {
  return nonisolatedGroupProfileData(profile, page, tokens, context, compositeGroupProfiles)
}
