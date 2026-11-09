/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Physical font/ink witness shared only by native table crop certificates.
// A shading operation is not authorized here: callers must reject it or prove
// a complete balanced foreign paint scope outside their preserved crop.
import { MAX_SCALE, MAX_EDGE } from './literature-pdf-crop.mjs'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'

// Inspect every descriptor chain before invoking any PDF.js getter. Unknown
// accessors must not run and mutate an earlier font after its bytes were checked.
const fontReadKeys = [
  'fontMatrix',
  'loadedName',
  'vertical',
  'missingFile',
  'isType3Font',
  'isInvalidPDFjsFont',
  'disableFontFace',
  'remeasure',
  'getPathGenerator',
  'compiledGlyphs',
  'fontExtraProperties'
]
function readSlots(object, keys) {
  const chain = []
  for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
    if (chain.length >= 8) throw Error('Unbounded font prototype chain')
    chain.push({
      owner,
      parent: Object.getPrototypeOf(owner),
      slots: keys.map((key) => [key, Object.getOwnPropertyDescriptor(owner, key)])
    })
  }
  return chain
}
function slotsCurrent(chain) {
  return chain.every(
    (level) =>
      Object.getPrototypeOf(level.owner) === level.parent &&
      level.slots.every(([key, before]) => {
        const now = Object.getOwnPropertyDescriptor(level.owner, key)
        return before === undefined
          ? now === undefined
          : now !== undefined &&
              ['value', 'writable', 'get', 'set', 'enumerable', 'configurable'].every(
                (name) => now[name] === before[name]
              )
      })
  )
}

function inventory(n) {
  const valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
    union = (rs) => [
      Math.min(...rs.map((r) => r[0])),
      Math.min(...rs.map((r) => r[1])),
      Math.max(...rs.map((r) => r[2])),
      Math.max(...rs.map((r) => r[3]))
    ]
  const box = (r, m) => {
    const p = [
      [r[0], r[1]],
      [r[2], r[1]],
      [r[2], r[3]],
      [r[0], r[3]]
    ]
    for (const q of p) Util.applyTransform(q, m)
    return union(p.map((q) => [q[0], q[1], q[0], q[1]]))
  }
  const viewport = { ...n.viewport, convertToViewportPoint: (x, y) => [x, n.viewport.height - y] },
    e = { images: [], paths: new Map(), texts: new Map(), frames: new Map() }
  collectClosedFigureFrames(n.operators, viewport, e)
  const fonts = new Map(
      n.glyphBounds.map((f) => [f.fontName, new Map(f.glyphs.map((g) => [g.fontChar, g.bounds]))])
    ),
    skipped = new Map(
      (n.skippedSpaceGlyphs === undefined ? [] : n.skippedSpaceGlyphs).map((g) => [
        g.operationIndex + ':' + g.glyphIndex,
        g
      ])
    ),
    usedSkipped = new Set(),
    stack = [],
    glyphs = [],
    groupStack = []
  let state = {
      font: undefined,
      size: undefined,
      tm: [1, 0, 0, 1, 0, 0],
      x: 0,
      y: 0,
      lx: 0,
      ly: 0,
      charSpacing: 0,
      wordSpacing: 0
    },
    text = false
  for (const [i, op] of n.operators.fnArray.entries()) {
    const a = n.operators.argsArray[i]
    if (op === OPS.beginGroup) {
      assert.equal(a[0].matrix, null)
      assert.equal(a[0].smask, null)
      assert.equal(a[0].knockout, false)
      assert(valid(a[0].bbox))
      groupStack.push(JSON.stringify(a[0]))
      continue
    }
    if (op === OPS.endGroup) {
      assert.equal(groupStack.pop(), JSON.stringify(a[0]))
      continue
    }
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push({ ...state, tm: [...state.tm] })
      continue
    }
    if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      assert(stack.length)
      state = stack.pop()
      continue
    }
    if (op === OPS.beginText) {
      assert(!text)
      text = true
      state = { ...state, tm: [1, 0, 0, 1, 0, 0], x: 0, y: 0, lx: 0, ly: 0 }
      continue
    }
    if (op === OPS.endText) {
      assert(text)
      text = false
      continue
    }
    if (op === OPS.setFont) {
      ;[state.font, state.size] = a
      continue
    }
    if (op === OPS.setCharSpacing) {
      state.charSpacing = a[0]
      continue
    }
    if (op === OPS.setWordSpacing) {
      state.wordSpacing = a[0]
      continue
    }
    if (op === OPS.setTextRenderingMode) {
      assert.equal(a[0], 0)
      continue
    }
    if (op === OPS.setTextMatrix) {
      assert(text)
      state.tm = Array.from(a[0])
      state.x = state.y = state.lx = state.ly = 0
      continue
    }
    if (op === OPS.moveText) {
      assert(text)
      state.x = state.lx += a[0]
      state.y = state.ly += a[1]
      continue
    }
    if (op !== OPS.showText) continue
    assert(text)
    const paint = e.texts.get(i)
    assert(paint)
    assert(valid(paint.clip))
    const m = Util.transform(viewport.transform, Util.transform(paint.transform, state.tm))
    assert(m.every(Number.isFinite))
    assert.equal(m[1], 0)
    assert.equal(m[2], 0)
    assert(m[0] > 0 && m[3] < 0)
    for (const [index, g] of a[0].entries()) {
      if (typeof g === 'number') {
        assert(Number.isFinite(g))
        state.x -= (g * state.size) / 1000
        continue
      }
      assert.equal(typeof g.unicode, 'string')
      assert.equal(typeof g.fontChar, 'string')
      assert(g.accent === null || g.accent === undefined)
      assert.equal(g.operatorListId, undefined)
      assert.equal(g.vmetric, undefined)
      assert(Number.isFinite(g.width) && g.width >= 0)
      const b = fonts.get(state.font)?.get(g.fontChar)
      assert(b && b.length === 4 && b.every(Number.isFinite))
      const skip = skipped.get(i + ':' + index)
      if (g.isInFont !== true) {
        assert(
          skip &&
            skip.fontName === state.font &&
            skip.fontChar === g.fontChar &&
            skip.width === g.width &&
            g.unicode === ' '
        )
        usedSkipped.add(i + ':' + index)
      }
      const ink = box(
          [
            state.x + b[0] * state.size,
            state.y + b[1] * state.size,
            state.x + b[2] * state.size,
            state.y + b[3] * state.size
          ],
          m
        ),
        advance = box(
          [state.x, state.y, state.x + (g.width * state.size) / 1000, state.y + state.size],
          m
        )
      assert(ink.every(Number.isFinite))
      assert(advance.every(Number.isFinite))
      glyphs.push({
        op: i,
        index,
        font: state.font,
        text: g.unicode,
        ink: skip ? [0, 0, 0, 0] : ink,
        advance,
        clippedInk: skip
          ? [0, 0, 0, 0]
          : [
              Math.max(ink[0], paint.clip[0]),
              Math.max(ink[1], paint.clip[1]),
              Math.min(ink[2], paint.clip[2]),
              Math.min(ink[3], paint.clip[3])
            ]
      })
      state.x +=
        (g.width * state.size) / 1000 + state.charSpacing + (g.isSpace ? state.wordSpacing : 0)
    }
  }
  assert.equal(stack.length, 0)
  assert.equal(groupStack.length, 0)
  assert(!text)
  assert.equal(usedSkipped.size, skipped.size)
  const visible = glyphs.flatMap((g) => Array.from(compact(g.text)).map((c) => ({ c, g }))),
    records = []
  let offset = 0
  for (const [index, raw] of n.content.items.entries()) {
    const chars = Array.from(compact(raw.str))
    if (!chars.length) continue
    const part = visible.slice(offset, offset + chars.length)
    offset += chars.length
    assert.equal(part.map((p) => p.c).join(''), chars.join(''), 'literal ' + index)
    assert(
      part.every((p) => p.g.font === raw.fontName),
      'font ' + index
    )
    const q = union(part.map((p) => p.g.advance)),
      v = [
        raw.transform[4],
        viewport.height - raw.transform[5] - raw.height,
        raw.transform[4] + raw.width,
        viewport.height - raw.transform[5]
      ]
    assert(
      Math.abs(q[1] - v[1]) <= 0.02 && Math.abs(q[3] - v[3]) <= 0.02,
      'vertical-native-binding ' + index
    )
    records.push({
      index,
      text: raw.str,
      ink: union(part.map((p) => p.g.ink)),
      advance: q,
      sourceRect: v,
      horizontalComplete: q.every((x, i) => Math.abs(x - v[i]) <= 0.02),
      glyphOperations: [...new Set(part.map((p) => p.g.op))]
    })
  }
  assert.equal(offset, visible.length)

  return { records, glyphs, e }
}
const compact = (s) => s.normalize('NFD').replace(/\s/gu, '')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]

// getOperatorList uses PDF.js's NullOptimizer, whereas display rendering folds
// q / translation / path / Q. Consume every original occurrence in order and
// retain its paint index. No bbox, string or reordered-paint matching is allowed.
function cropOperatorOccurrences(actual, rendered) {
  assert(
    actual &&
      Array.isArray(actual.fnArray) &&
      Array.isArray(actual.argsArray) &&
      actual.fnArray.length === actual.argsArray.length &&
      actual.fnArray.length <= 100000 &&
      rendered.fnArray.length === rendered.argsArray.length
  )
  const occurrences = []
  let i = 0
  for (const op of rendered.fnArray) {
    if (actual.fnArray[i] === op) {
      occurrences.push({ index: i, args: actual.argsArray[i++] })
      continue
    }
    const f = actual.fnArray,
      a = actual.argsArray,
      m = a[i + 1],
      p = a[i + 2]
    assert(
      op === OPS.constructPath &&
        f[i] === OPS.save &&
        a[i] === null &&
        f[i + 1] === OPS.transform &&
        f[i + 2] === OPS.constructPath &&
        f[i + 3] === OPS.restore &&
        a[i + 3] === null &&
        Array.isArray(m) &&
        m.length === 6 &&
        m.every(Number.isFinite) &&
        m[0] === 1 &&
        m[1] === 0 &&
        m[2] === 0 &&
        m[3] === 1 &&
        Array.isArray(p) &&
        p.length === 3 &&
        [OPS.fill, OPS.stroke].includes(p[0]) &&
        Array.isArray(p[1]) &&
        p[1].length === 1 &&
        p[1][0] instanceof Float32Array &&
        p[1][0].length > 0 &&
        p[1][0].length <= 100000 &&
        p[1][0].every(Number.isFinite) &&
        p[2]?.length === 4 &&
        Array.from(p[2]).every(Number.isFinite)
    )
    const args = structuredClone(p),
      path = args[1][0]
    for (let k = 0; k < path.length;) {
      const command = path[k++]
      if (command === 0 || command === 1) {
        assert(k + 2 <= path.length)
        Util.applyTransform(path, m, k)
        k += 2
      } else if (command === 2) {
        assert(k + 6 <= path.length)
        Util.applyTransformToBezier(path, m, k)
        k += 6
      } else assert.equal(command, 4)
    }
    Util.scaleMinMax(m, args[2])
    assert(path.every(Number.isFinite) && Array.from(args[2]).every(Number.isFinite))
    occurrences.push({ index: i + 2, args })
    i += 4
  }
  assert.equal(i, actual.fnArray.length)
  assert.equal(new Set(occurrences.map((p) => p.index)).size, occurrences.length)
  return occurrences
}

// The only foreign color operator accepted is a single filled mask inside this
// exact local q / clip / color / fill / Q sequence. It cannot paint text or leak state.
function closedForeignShading(n, table, v, i) {
  const f = n.operators.fnArray,
    a = n.operators.argsArray
  if (
    f[i - 3] !== OPS.save ||
    f[i - 2] !== OPS.eoClip ||
    f[i - 1] !== OPS.constructPath ||
    a[i - 1]?.[0] !== OPS.endPath ||
    f[i + 1] !== OPS.constructPath ||
    ![OPS.fill, OPS.eoFill].includes(a[i + 1]?.[0]) ||
    f[i + 2] !== OPS.restore
  )
    return
  const color = a[i],
    clip = Array.from(a[i - 1]?.[1]?.[0] ?? [])
  if (
    color?.length !== 3 ||
    color[0] !== 'Shading' ||
    typeof color[1] !== 'string' ||
    !color[1] ||
    color[1].length > 256 ||
    color[2] !== null ||
    clip.length !== 13 ||
    !clip.every(Number.isFinite) ||
    clip[0] !== 0 ||
    clip[3] !== 1 ||
    clip[6] !== 1 ||
    clip[9] !== 1 ||
    clip[12] !== 4 ||
    clip[1] !== clip[10] ||
    clip[4] !== clip[7] ||
    clip[2] !== clip[5] ||
    clip[8] !== clip[11] ||
    clip[1] >= clip[4] ||
    clip[2] >= clip[8]
  )
    return
  if (
    !(v.scale > 0) ||
    !valid(table.cropRect) ||
    !valid(table.caption?.rect) ||
    table.caption.page !== table.page
  )
    return
  const old = table.cropRect.map((x) => x / v.scale),
    s = Math.min(MAX_SCALE, MAX_EDGE / Math.max(old[2] - old[0], old[3] - old[1])),
    aa = 1 / s,
    band = [
      old[0] - aa,
      Math.min(old[1], table.caption.rect[1]) - aa,
      old[2] + 2 * aa,
      old[3] + 2 * aa
    ],
    records = n.graphicsBounds.filter((g) => g.operationIndex === i + 1)
  if (records.length !== 1 || records[0].kind !== 'path') return
  const paint = records[0].normalizedRect?.map(
    (x, j) => x * (j % 2 ? n.viewport.height : n.viewport.width)
  )
  if (
    !valid(paint) ||
    (paint[0] < band[2] && paint[2] > band[0] && paint[1] < band[3] && paint[3] > band[1])
  )
    return
  return {
    operationIndex: i,
    save: i - 3,
    restore: i + 2,
    paintOperation: i + 1,
    paintBounds: paint,
    exclusionBand: band
  }
}

export function captureNativeTableCropWitness(
  table,
  context,
  { page, nativePage, nativeContent },
  purpose
) {
  try {
    const n = context.nativeGlyphContext,
      v = context.viewport,
      raw = n.content.items
    assert(
      n.viewport.scale === 1 &&
        n.viewport.rotation === 0 &&
        page.invalidGraphicsBounds === 0 &&
        page.pageNumber === table.page &&
        same(n.graphicsBounds, page.graphicsBounds)
    )
    assert(
      raw.length > 0 &&
        raw.length <= 4096 &&
        raw.length === nativeContent.items.length &&
        raw.length === context.sourceContent.items.length
    )
    assert(same(n.viewport.transform, [1, 0, 0, -1, 0, n.viewport.height]))
    const forward = new Map(),
      reverse = new Map(),
      fontBindings = []
    for (const [index, a] of raw.entries()) {
      const b = nativeContent.items[index],
        c = context.sourceContent.items[index]
      assert(
        ['str', 'width', 'height', 'dir', 'hasEOL'].every((k) => a[k] === b[k] && a[k] === c[k]) &&
          same(a.transform, b.transform) &&
          same(a.transform, c.transform)
      )
      assert(
        same(n.content.styles[a.fontName], nativeContent.styles[b.fontName]) &&
          same(n.content.styles[a.fontName], context.sourceContent.styles[c.fontName])
      )
      assert(!forward.has(a.fontName) || forward.get(a.fontName) === b.fontName)
      assert(!reverse.has(b.fontName) || reverse.get(b.fontName) === a.fontName)
      forward.set(a.fontName, b.fontName)
      reverse.set(b.fontName, a.fontName)
      if (a.str.trim()) {
        assert(
          c.sourceItem?.pageNumber === table.page &&
            c.sourceItem.index === index &&
            c.sourceItem.text === a.str
        )
        assert(
          a.dir === 'ltr' &&
            a.transform[0] > 0 &&
            a.transform[1] === 0 &&
            a.transform[2] === 0 &&
            a.transform[3] === a.height &&
            n.content.styles[a.fontName].vertical === false
        )
      }
    }

    let operatorBridge, operatorBridgeCurrent
    if (purpose === 'closed-ruled-body' || n.glyphBounds.some((f) => !forward.has(f.fontName))) {
      const actual = context.operators
      const occurrences = cropOperatorOccurrences(actual, n.operators)
      for (const [i, op] of n.operators.fnArray.entries())
        if (op === OPS.setFont) {
          const a = n.operators.argsArray[i],
            b = occurrences[i].args
          assert(
            Array.isArray(a) &&
              a.length === 2 &&
              Array.isArray(b) &&
              b.length === 2 &&
              typeof a[0] === 'string' &&
              typeof b[0] === 'string' &&
              a[1] === b[1]
          )
          assert(!forward.has(a[0]) || forward.get(a[0]) === b[0])
          assert(!reverse.has(b[0]) || reverse.get(b[0]) === a[0])
          forward.set(a[0], b[0])
          reverse.set(b[0], a[0])
        }
      for (const [i, op] of n.operators.fnArray.entries()) {
        const a = n.operators.argsArray[i]
        const expected =
          op === OPS.setFont
            ? [forward.get(a[0]), a[1]]
            : op === OPS.dependency
              ? a.map((id) => forward.get(id) ?? id)
              : a
        assert(isDeepStrictEqual(expected, occurrences[i].args))
      }
      assert(n.glyphBounds.every((f) => forward.has(f.fontName)))
      operatorBridge = actual
      operatorBridgeCurrent = retainNativeRecoveryInputs([actual, n.operators])
      assert(operatorBridgeCurrent)
    }
    if (purpose === 'closed-ruled-body') {
      assert(operatorBridge)
      let matrix = [1, 0, 0, 1, 0, 0],
        pending = false
      const stack = []
      for (const [i, op] of n.operators.fnArray.entries()) {
        const a = n.operators.argsArray[i]
        assert(
          ![
            OPS.beginGroup,
            OPS.endGroup,
            OPS.paintFormXObjectBegin,
            OPS.paintFormXObjectEnd
          ].includes(op)
        )
        if (op === OPS.save) {
          assert(!pending)
          stack.push([...matrix])
        } else if (op === OPS.restore) {
          assert(!pending && stack.length)
          matrix = stack.pop()
        } else if (op === OPS.transform) {
          assert(
            !pending &&
              Array.isArray(a) &&
              a.length === 6 &&
              a.every(Number.isFinite) &&
              a[1] === 0 &&
              a[2] === 0 &&
              a[0] !== 0 &&
              a[3] !== 0
          )
          matrix = Util.transform(matrix, a)
        } else if (op === OPS.clip) {
          assert(
            !pending &&
              a === null &&
              n.operators.fnArray[i - 1] === OPS.save &&
              n.operators.fnArray[i + 1] === OPS.constructPath
          )
          const next = n.operators.argsArray[i + 1],
            q = Array.from(next?.[1]?.[0] ?? []),
            bounds = Array.from(next?.[2] ?? [])
          assert(
            next[0] === OPS.endPath &&
              q.length === 13 &&
              q.every(Number.isFinite) &&
              q[0] === 0 &&
              q[3] === 1 &&
              q[6] === 1 &&
              q[9] === 1 &&
              q[12] === 4
          )
          assert(
            q[1] === q[10] &&
              q[2] === q[5] &&
              q[4] === q[7] &&
              q[8] === q[11] &&
              q[1] < q[4] &&
              q[2] < q[8] &&
              same(bounds, [q[1], q[2], q[4], q[8]])
          )
          assert(
            matrix.every(Number.isFinite) &&
              matrix[1] === 0 &&
              matrix[2] === 0 &&
              matrix[0] !== 0 &&
              matrix[3] !== 0
          )
          pending = true
        } else if (pending) {
          assert(op === OPS.constructPath && a[0] === OPS.endPath)
          pending = false
        }
      }
      assert(!pending && !stack.length)
    }

    for (const f of n.glyphBounds) {
      const font = nativePage.commonObjs.get(forward.get(f.fontName)),
        fontSlots = readSlots(font, fontReadKeys)
      assert(
        fontReadKeys.every((key) => {
          const d = Object.getOwnPropertyDescriptor(font, key)
          return !d || (!d.get && !d.set)
        })
      )
      assert(
        font.missingFile === false &&
          font.isType3Font === false &&
          font.isInvalidPDFjsFont === false &&
          font.disableFontFace === true &&
          (font.remeasure === undefined || font.remeasure === false) &&
          font.vertical === false &&
          same(Array.from(font.fontMatrix), [0.001, 0, 0, 0.001, 0, 0])
      )
      const matrixDescriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(font),
        'fontMatrix'
      )
      assert(!Object.hasOwn(font, 'fontMatrix') && typeof matrixDescriptor?.get === 'function')
      const paths = f.glyphs.map((g) => {
        const compiled = font.getPathGenerator(nativePage.commonObjs, g.fontChar)
        assert(same(Array.from(compiled.getBounds()), g.bounds))
        const key = font.loadedName + '_path_' + g.fontChar,
          info = nativePage.commonObjs.get(key),
          owner = Object.getPrototypeOf(info),
          getter = Object.getOwnPropertyDescriptor(owner, 'path')?.get,
          data = info.path
        assert(!Object.hasOwn(info, 'path') && typeof getter === 'function')
        assert(
          ArrayBuffer.isView(data) &&
            !(data instanceof DataView) &&
            data.buffer instanceof ArrayBuffer
        )
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        return {
          infoSlots: readSlots(info, ['path']),
          compiledSlots: readSlots(compiled, ['getBounds']),
          viewSlots: readSlots(Object.getPrototypeOf(data), ['buffer', 'byteOffset', 'byteLength']),
          character: g.fontChar,
          key,
          info,
          owner,
          getter,
          descriptor: Object.getOwnPropertyDescriptor(owner, 'path'),
          buffer: data.buffer,
          offset: data.byteOffset,
          length: data.byteLength,
          prototype: Object.getPrototypeOf(data),
          bytes: Uint8Array.from(bytes),
          compiled,
          getBounds: compiled.getBounds,
          bounds: [...g.bounds]
        }
      })
      assert(paths.reduce((n, p) => n + p.length, 0) <= 1024 * 1024)
      const cache = Object.getOwnPropertyDescriptor(font, 'compiledGlyphs')?.value
      fontBindings.push({
        fontSlots,
        cacheSlots: cache
          ? readSlots(
              cache,
              paths.map((p) => p.character)
            )
          : [],
        id: forward.get(f.fontName),
        font,
        fontOwner: Object.getPrototypeOf(font),
        loadedName: font.loadedName,
        matrixDescriptor,
        matrixGetter: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(font), 'fontMatrix')
          ?.get,
        matrix: JSON.stringify(Array.from(font.fontMatrix)),
        getPath: font.getPathGenerator,
        paths
      })
    }
    const allowed = new Set(
      [
        'setFillRGBColor',
        'setStrokeRGBColor',
        'beginText',
        'dependency',
        'setFont',
        'setTextMatrix',
        'showText',
        'endText',
        'save',
        'transform',
        'setDash',
        'setLineCap',
        'setLineWidth',
        'constructPath',
        'restore',
        'moveText',
        'beginGroup',
        'paintFormXObjectBegin',
        'beginMarkedContent',
        'eoClip',
        'setGState',
        'endMarkedContent',
        'beginMarkedContentProps',
        'paintFormXObjectEnd',
        'setCharSpacing',
        'endGroup'
      ].map((k) => OPS[k])
    )
    const foreignShadingScopes = []
    assert(
      n.operators.fnArray.length === n.operators.argsArray.length &&
        n.operators.fnArray.length <= 100000 &&
        n.operators.fnArray.every((op, i) => {
          // This pixel-only purpose inventories the same render's image paints.
          // Its caller must exclude every image from the expanded table crop;
          // it neither aliases API image IDs nor claims image Source ownership.
          if (purpose === 'foreign-raster-footer' && op === OPS.paintImageXObject) return true
          if (allowed.has(op) || (purpose === 'closed-ruled-body' && op === OPS.clip)) return true
          if (op !== OPS.setFillColorN) return false
          const scope = closedForeignShading(n, table, v, i)
          if (!scope) return false
          foreignShadingScopes.push(scope)
          return true
        })
    )
    for (const [i, op] of n.operators.fnArray.entries())
      if (op === OPS.setGState)
        assert(
          n.operators.argsArray[i][0].every(
            ([key, value]) =>
              ['ca', 'CA', 'LW', 'ML', 'D', 'LC', 'LJ'].includes(key) ||
              (key === 'BM' && value === 'source-over') ||
              (key === 'SMask' && value === false)
          )
        )
    const { records, glyphs, e } = inventory(n)
    const paints = [...e.paths.keys()].filter(
      (i) => ![OPS.clip, OPS.eoClip, OPS.endPath].includes(n.operators.argsArray[i]?.[0])
    )
    assert(
      (purpose === 'foreign-raster-footer' || e.images.length === 0) &&
        paints.length + e.images.length === n.graphicsBounds.length &&
        new Set(n.graphicsBounds.map((g) => g.operationIndex)).size === n.graphicsBounds.length &&
        n.graphicsBounds.every((g) =>
          g.kind === 'path'
            ? paints.includes(g.operationIndex)
            : purpose === 'foreign-raster-footer' &&
              g.kind === 'image' &&
              e.images.filter((image) => image.operationIndex === g.operationIndex).length === 1
        )
    )

    const fontCurrent = () => {
      // No read below this preflight may invoke an unknown font/path accessor.
      if (
        !fontBindings.every(
          (b) =>
            slotsCurrent(b.fontSlots) &&
            slotsCurrent(b.cacheSlots) &&
            b.paths.every(
              (p) =>
                slotsCurrent(p.infoSlots) &&
                slotsCurrent(p.compiledSlots) &&
                slotsCurrent(p.viewSlots)
            )
        )
      )
        return false
      return fontBindings.every(
        (b) =>
          nativePage.commonObjs.get(b.id) === b.font &&
          JSON.stringify(Array.from(b.font.fontMatrix)) === b.matrix &&
          b.font.loadedName === b.loadedName &&
          b.font.vertical === false &&
          b.font.missingFile === false &&
          b.font.isType3Font === false &&
          b.font.isInvalidPDFjsFont === false &&
          b.font.disableFontFace === true &&
          (b.font.remeasure === undefined || b.font.remeasure === false) &&
          b.font.getPathGenerator === b.getPath &&
          b.paths.every((p) => {
            if (nativePage.commonObjs.get(p.key) !== p.info) return false
            const data = p.getter.call(p.info)
            if (
              !ArrayBuffer.isView(data) ||
              Object.getPrototypeOf(data) !== p.prototype ||
              ['buffer', 'byteOffset', 'byteLength'].some((k) => Object.hasOwn(data, k)) ||
              data.buffer !== p.buffer ||
              data.byteOffset !== p.offset ||
              data.byteLength !== p.length ||
              b.getPath.call(b.font, nativePage.commonObjs, p.character) !== p.compiled ||
              !same(Array.from(p.getBounds.call(p.compiled)), p.bounds)
            )
              return false
            return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).every(
              (v, i) => v === p.bytes[i]
            )
          })
      )
    }
    const refs = () => [
        table.cells,
        table.grid,
        table.unassigned,
        table.clipped,
        context.nativeGlyphContext,
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
        n.viewport,
        context.viewport,
        context.rulePaintBounds,
        page.graphicsBounds,
        nativeContent,
        nativeContent.items,
        nativeContent.styles,
        operatorBridge && context.operators,
        operatorBridge && context.operators.fnArray,
        operatorBridge && context.operators.argsArray,
        nativePage.commonObjs,
        nativePage.commonObjs.get
      ],
      originalRefs = refs(),
      value = () =>
        JSON.stringify({
          table,
          actualOperators: operatorBridge && context.operators,
          source: context.sourceContent,
          native: n,
          viewport: context.viewport,
          paint: [...context.rulePaintBounds],
          page,
          nativeContent
        }),
      originalValue = value(),
      data = JSON.stringify({
        records,
        glyphs,
        paths: [...e.paths],
        texts: [...e.texts],
        images: e.images,
        foreignShadingScopes
      })
    const current = () => {
      try {
        return (
          refs().every((r, i) => r === originalRefs[i]) &&
          (!operatorBridgeCurrent || operatorBridgeCurrent()) &&
          value() === originalValue &&
          fontCurrent() &&
          JSON.stringify({
            records,
            glyphs,
            paths: [...e.paths],
            texts: [...e.texts],
            images: e.images,
            foreignShadingScopes
          }) === data
        )
      } catch {
        return false
      }
    }
    return {
      records,
      glyphs,
      e,
      current,
      foreignShadingScopes,
      patternOperations: foreignShadingScopes.map((s) => s.operationIndex)
    }
  } catch {
    return
  }
}
