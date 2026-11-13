/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  retainNativeArrayPixelInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { nativeCompositingByteWindow } from './literature-pdf-native-compositing-profile.mjs'

// A private potential-pixel inventory. Neither its AABBs nor its curved clips
// are an exact-clip, visible-paint, solid-fill or Source witness.
const programs = new WeakMap(),
  NONE = 0xffffffff,
  MAX_PATHS = 16384,
  MAX_SCALARS = 2097152,
  MAX_PATH_SCALARS = 16384,
  MAX_PAYLOAD = 1024 * 1024
const finite = (a, n) =>
    (Array.isArray(a) || ArrayBuffer.isView(a)) &&
    a.length === n &&
    Array.from(a).every(Number.isFinite),
  valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3],
  frozen = (a) => Object.freeze(a),
  intersect = (a, b) => [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3])
  ],
  mapPoint = (x, y, m) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]],
  box = (r, m) => {
    const p = [
      mapPoint(r[0], r[1], m),
      mapPoint(r[2], r[1], m),
      mapPoint(r[2], r[3], m),
      mapPoint(r[0], r[3], m)
    ]
    return [
      Math.min(...p.map((q) => q[0])),
      Math.min(...p.map((q) => q[1])),
      Math.max(...p.map((q) => q[0])),
      Math.max(...p.map((q) => q[1]))
    ]
  },
  rectPoints = (p) => {
    if (
      p.length !== 4 ||
      new Set(p.map((q) => q.join(','))).size !== 4 ||
      p.some((q, i) => {
        const n = p[(i + 1) % 4]
        return (q[0] === n[0]) === (q[1] === n[1])
      })
    )
      return null
    return [
      Math.min(...p.map((q) => q[0])),
      Math.min(...p.map((q) => q[1])),
      Math.max(...p.map((q) => q[0])),
      Math.max(...p.map((q) => q[1]))
    ]
  }

function readonlyMap(map) {
  return frozen({
    get size() {
      return map.size
    },
    get: (i) => map.get(i),
    has: (i) => map.has(i),
    entries: () => map.entries(),
    values: () => map.values(),
    keys: () => map.keys(),
    [Symbol.iterator]: () => map.entries()
  })
}

// Stream original scalars. Control-point convex hulls are upper bounds for
// cubics, not a flattened replacement for their original renderer paths.
function pathGeometry(paths, matrix, clipOnly) {
  let count = 0,
    current,
    start,
    closed = false,
    contours = 0,
    curves = false,
    drawn = false,
    loX = Infinity,
    loY = Infinity,
    hiX = -Infinity,
    hiY = -Infinity
  const vertices = []
  const add = (x, y) => {
    const q = mapPoint(x, y, matrix)
    if (!q.every(Number.isFinite)) throw Error('Nonfinite transformed path.')
    loX = Math.min(loX, q[0])
    loY = Math.min(loY, q[1])
    hiX = Math.max(hiX, q[0])
    hiY = Math.max(hiY, q[1])
  }
  if (!Array.isArray(paths) || !paths.length) return
  for (const p of paths) {
    if ((!Array.isArray(p) && !ArrayBuffer.isView(p)) || !p.length || p.length > MAX_PATH_SCALARS)
      return
    count += p.length
    if (count > MAX_PATH_SCALARS) return
    for (let n = 0; n < p.length;) {
      const cmd = p[n++],
        length = cmd === 0 || cmd === 1 ? 2 : cmd === 2 ? 6 : cmd === 4 ? 0 : -1
      if (length < 0 || n + length > p.length) return
      for (let j = 0; j < length; j++) if (!Number.isFinite(p[n + j])) return
      if (cmd === 0) {
        if (clipOnly && !closed && contours) return
        current = [p[n], p[n + 1]]
        start = current
        if (!closed) contours++
        if (clipOnly && !closed) vertices.push(mapPoint(...current, matrix))
      } else {
        if (!current || (clipOnly && closed)) return
        if (cmd === 1 || cmd === 2) {
          add(...current)
          for (let j = 0; j < length; j += 2) add(p[n + j], p[n + j + 1])
          current = [p[n + length - 2], p[n + length - 1]]
          if (clipOnly && cmd === 1) vertices.push(mapPoint(...current, matrix))
          if (cmd === 2) curves = true
          drawn = true
        } else {
          add(...current)
          add(...start)
          current = start
          closed = true
        }
      }
      n += length
    }
  }
  if (
    !drawn ||
    ![loX, loY, hiX, hiY].every(Number.isFinite) ||
    (clipOnly && (!closed || contours !== 1 || !valid([loX, loY, hiX, hiY])))
  )
    return
  return {
    bounds: [loX, loY, hiX, hiY],
    count,
    exact: clipOnly && !curves ? rectPoints(vertices) : null,
    curves
  }
}

export function createNativeBoundedPixelProgram(page, tokens, context) {
  try {
    const own = nativeRecoveryOwnValues(context)
    if (!own) return
    const v = own.viewport,
      o = own.operators,
      retained = retainNativeArrayPixelInputs([page, tokens, context], v)
    if (
      !retained ||
      !Array.isArray(tokens) ||
      !finite(v?.transform, 6) ||
      v.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page?.width ||
      v.height !== page?.height ||
      page.rotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      page.pageNumber !== context.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      !Array.isArray(o?.fnArray) ||
      !Array.isArray(o.argsArray) ||
      o.fnArray.length !== o.argsArray.length ||
      o.fnArray.length > 100000 ||
      context.type3GlyphPrograms !== undefined ||
      context.pixelType3Programs !== undefined
    )
      return
    let pathCount = 0,
      preflightScalars = 0,
      maxPathScalars = 0
    for (let i = 0; i < o.fnArray.length; i++)
      if (o.fnArray[i] === OPS.constructPath) {
        pathCount++
        const paths = o.argsArray[i]?.[1]
        if (!Array.isArray(paths) || !paths.length) return
        let count = 0
        for (const p of paths) {
          if ((!Array.isArray(p) && !ArrayBuffer.isView(p)) || !p.length) return
          count += p.length
        }
        preflightScalars += count
        maxPathScalars = Math.max(maxPathScalars, count)
        if (count > MAX_PATH_SCALARS || preflightScalars > MAX_SCALARS) return
      }
    if (!pathCount || pathCount > MAX_PATHS || pathCount * 54 > MAX_PAYLOAD) return
    const operationIndices = new Uint32Array(pathCount),
      bounds = new Float64Array(pathCount * 4),
      floors = new Float64Array(pathCount),
      clipIndices = new Uint32Array(pathCount),
      scopeIndices = new Uint32Array(pathCount),
      paintFlags = new Uint8Array(pathCount),
      partitions = new Uint8Array(pathCount),
      columns = [
        operationIndices,
        bounds,
        floors,
        clipIndices,
        scopeIndices,
        paintFlags,
        partitions
      ],
      clips = [],
      scopes = [],
      stack = [],
      texts = new Map(),
      images = [],
      groups = new Map(),
      patternStates = new Map(),
      miterEvents = [{ operationIndex: -1, value: 10 }]
    let payload = pathCount * 54 + 12,
      scalarCount = 0,
      row = 0,
      groupDepth = 0,
      maxGroupDepth = 0,
      pending,
      currentScope = NONE,
      state = {
        transform: [1, 0, 0, 1, 0, 0],
        clip: 0,
        lineWidth: 1,
        lineCap: 0,
        lineJoin: 0,
        miter: 10,
        solidStroke: true,
        fillAlpha: 1,
        strokeAlpha: 1
      }
    const charge = (n) => {
      payload += n
      if (payload > MAX_PAYLOAD) throw Error('Packed budget.')
    }
    const addClip = (origin, rawBounds, exact) => {
      if (clips.length >= 256) throw Error('Clip node budget.')
      const parent = clips[state.clip],
        b = parent ? intersect(parent.bounds, rawBounds) : rawBounds
      if (!finite(b, 4)) throw Error('Unknown clip.')
      // A zero-area mathematical intersection is not a zero-pixel witness:
      // successive device clip masks can share antialias coverage at touching
      // edges. No original renderer zero-paint witness is available here, so
      // both touching and separated intersections remain Unknown/refuse. Empty
      // is a distinct consumer state; this observer must not fabricate it.
      if (!valid(b)) throw Error('Unproved empty raster clip.')
      const e =
        parent && !parent.exactClip
          ? null
          : parent
            ? exact && intersect(parent.exactClip, exact)
            : exact
      charge(
        32 +
          4 * 3 +
          1 +
          (e ? 32 : 0) +
          (origin.originalArgs ? 8 : 0) +
          (origin.originalPaths ? 8 : 0)
      )
      const clip = frozen({
        tag: 'Bounded',
        bounds: frozen(b),
        exactClip: e ? frozen(e) : null,
        parent: parent ? state.clip : NONE,
        ...origin
      })
      clips.push(clip)
      state.clip = clips.length - 1
      return clip
    }
    addClip(
      { kind: 'page', operationIndex: NONE },
      [0, 0, v.width, v.height],
      [0, 0, v.width, v.height]
    )
    const clipFields = () => {
      const c = clips[state.clip]
      return {
        clip: c.exactClip,
        exactClip: c.exactClip,
        clipState: c,
        potentialClipEnvelope: c.bounds,
        clipIndex: state.clip
      }
    }
    const world = () => {
      const m = Util.transform(v.transform, state.transform)
      if (!finite(m, 6) || Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12)
        throw Error('Unknown transform.')
      return m
    }
    const enter = (op, i, args) => {
      if (pending !== undefined || stack.length >= 32 || scopes.length >= 256)
        throw Error('Scope budget.')
      charge(4 * 5 + 8)
      const scope = { begin: i, end: NONE, op, parent: currentScope, args }
      scopes.push(scope)
      stack.push({
        state: { ...state, transform: [...state.transform] },
        op,
        scope: currentScope,
        index: scopes.length - 1
      })
      currentScope = scopes.length - 1
      return scope
    }
    const leave = (op, i) => {
      const prev = stack.pop()
      if (!prev || pending !== undefined || prev.op !== op) throw Error('Unbalanced scope.')
      scopes[prev.index].end = i
      state = prev.state
      currentScope = prev.scope
      return scopes[prev.index]
    }
    const plainOps = new Set([
      OPS.dependency,
      OPS.beginText,
      OPS.endText,
      OPS.setTextMatrix,
      OPS.moveText,
      OPS.nextLine,
      OPS.setLeading,
      OPS.setFont,
      OPS.setCharSpacing,
      OPS.setWordSpacing,
      OPS.setHScale,
      OPS.setTextRise,
      OPS.setTextRenderingMode,
      OPS.setFillRGBColor,
      OPS.setStrokeRGBColor,
      OPS.setRenderingIntent
    ])
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save) enter(op, i, a)
      else if (op === OPS.restore) leave(OPS.save, i)
      else if (op === OPS.transform) {
        if (!finite(a, 6)) return
        state.transform = Util.transform(state.transform, a)
        world()
      } else if (op === OPS.paintFormXObjectBegin) {
        enter(op, i, a)
        if (!Array.isArray(a) || a.length !== 2 || (a[0] !== null && !finite(a[0], 6))) return
        if (a[0]) state.transform = Util.transform(state.transform, a[0])
        if (a[1] !== null && a[1] !== undefined) {
          if (!valid(a[1])) return
          const m = world(),
            b = box(a[1], m),
            exact = m[1] === 0 && m[2] === 0 ? b : null
          addClip({ kind: 'FormBBox', operationIndex: i, originalArgs: a }, b, exact)
        }
      } else if (op === OPS.paintFormXObjectEnd) leave(OPS.paintFormXObjectBegin, i)
      else if (op === OPS.beginGroup) {
        const g = a?.[0]
        if (
          !g ||
          Object.keys(g).sort().join(',') !== 'bbox,isolated,knockout,matrix,smask' ||
          g.matrix !== null ||
          g.smask !== null ||
          g.isolated !== true ||
          g.knockout !== false ||
          !valid(g.bbox) ||
          groupDepth >= 2 ||
          groups.size >= 64 ||
          state.fillAlpha !== 1 ||
          state.strokeAlpha !== 1
        )
          return
        const scope = enter(op, i, g),
          m = world(),
          rect = box(g.bbox, m)
        addClip(
          { kind: 'GroupBBox', operationIndex: i, originalArgs: g },
          rect,
          m[1] === 0 && m[2] === 0 ? rect : null
        )
        groups.set(i, { ...scope, rect: frozen(rect), ...clipFields() })
        groupDepth++
        maxGroupDepth = Math.max(maxGroupDepth, groupDepth)
      } else if (op === OPS.endGroup) {
        const scope = leave(OPS.beginGroup, i),
          g = groups.get(scope.begin)
        if (JSON.stringify(scope.args) !== JSON.stringify(a?.[0])) return
        g.end = i
        groupDepth--
      } else if (op === OPS.setLineWidth || op === OPS.setMiterLimit) {
        if (!finite(a, 1) || a[0] < (op === OPS.setMiterLimit ? 1 : 0)) return
        if (op === OPS.setLineWidth) state.lineWidth = a[0]
        else state.miter = a[0]
      } else if (op === OPS.setLineCap || op === OPS.setLineJoin) {
        if (!finite(a, 1) || ![0, 1, 2].includes(a[0])) return
        if (op === OPS.setLineCap) state.lineCap = a[0]
        else state.lineJoin = a[0]
      } else if (op === OPS.setDash) {
        if (
          !Array.isArray(a) ||
          a.length !== 2 ||
          !Array.isArray(a[0]) ||
          !a[0].every((x) => Number.isFinite(x) && x >= 0) ||
          !Number.isFinite(a[1])
        )
          return
        state.solidStroke = a[0].length === 0
      } else if (op === OPS.setGState) {
        if (!Array.isArray(a?.[0])) return
        for (const entry of a[0]) {
          if (!Array.isArray(entry) || entry.length !== 2) return
          const [key, value] = entry
          if (
            (key === 'CA' || key === 'ca') &&
            Number.isFinite(value) &&
            value >= 0 &&
            value <= 1
          ) {
            if (key === 'CA') state.strokeAlpha = value
            else state.fillAlpha = value
          } else if (!(
            (key === 'SMask' && value === false) ||
            (key === 'BM' && value === 'source-over')
          ))
            return
        }
      } else if (op === OPS.clip || op === OPS.eoClip) {
        if (pending !== undefined) return
        pending = { operationIndex: i, rule: op }
      } else if (op === OPS.constructPath) {
        const paint = a?.[0],
          ps = a?.[1],
          b = a?.[2]
        if (
          ![
            OPS.stroke,
            OPS.closeStroke,
            OPS.fill,
            OPS.eoFill,
            OPS.fillStroke,
            OPS.eoFillStroke,
            OPS.closeFillStroke,
            OPS.closeEOFillStroke,
            OPS.endPath
          ].includes(paint)
        )
          return
        const m = world(),
          geometry = pathGeometry(ps, [1, 0, 0, 1, 0, 0], false)
        if (!geometry || !finite(b, 4)) return
        scalarCount += geometry.count
        if (scalarCount > MAX_SCALARS) return
        operationIndices[row] = i
        clipIndices[row] = state.clip
        scopeIndices[row] = currentScope
        paintFlags[row] = paint === OPS.endPath ? 0 : 1
        if (clips[state.clip].tag === 'Empty') paintFlags[row] |= 2
        const local = { ...state, clip: clips[state.clip].exactClip },
          single = { argsArray: { [i]: [paint, ps, geometry.bounds] } },
          metric = nativeFigurePathPaint(
            {
              o: single,
              v,
              finite,
              valid,
              box,
              strokeMargins: { get: () => (state.lineJoin === 0 ? state.miter : Math.SQRT2) }
            },
            i,
            local
          )
        if (!metric) return
        bounds.set(metric.rect, row * 4)
        floors[row] = metric.floor
        row++
        if (pending !== undefined) {
          const shape = pathGeometry(ps, m, true)
          if (!shape) return
          addClip(
            {
              kind: 'path',
              operationIndex: i,
              clipOperationIndex: pending.operationIndex,
              rule: pending.rule,
              originalArgs: a,
              originalPaths: ps
            },
            shape.bounds,
            shape.exact
          )
          pending = undefined
        }
      } else if (op === OPS.showText) {
        if (texts.size >= 4096) return
        charge(48 + 4 + 8)
        texts.set(
          i,
          frozen({ transform: frozen([...state.transform]), scope: currentScope, ...clipFields() })
        )
      } else if (op === OPS.paintImageXObject) {
        if (images.length >= 64 || !Array.isArray(a) || typeof a[0] !== 'string') return
        const m = world(),
          unit = [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1]
          ].map((p) => frozen(mapPoint(...p, m))),
          full = box([0, 0, 1, 1], m),
          c = clips[state.clip]
        charge(64 + 32 + 32 + 4 + 4 + 8)
        images.push(
          frozen({
            operationIndex: i,
            scope: currentScope,
            ...clipFields(),
            rect: frozen(intersect(full, c.bounds)),
            fullInk: frozen(full),
            originalUnitQuad: frozen(unit),
            originalArgs: a
          })
        )
      } else if (op === OPS.setFillColorN) {
        // Only bind a potential pattern paint. The caller must separately
        // close the original resource; this does not prove a color or pixel.
        if (
          !Array.isArray(a) ||
          a.length !== 3 ||
          a[0] !== 'Shading' ||
          typeof a[1] !== 'string' ||
          !finite(a[2], 6) ||
          Math.abs(a[2][0] * a[2][3] - a[2][1] * a[2][2]) < 1e-12
        )
          return
        if (patternStates.size >= 256) return
        charge(4 + 8 * 3)
        patternStates.set(
          i,
          frozen({
            kind: 'potential-path-pattern',
            originalArgs: a,
            resourceId: a[1],
            matrix: a[2],
            visibilityAuthority: false
          })
        )
      } else if (!plainOps.has(op)) return
      if (state.miter !== miterEvents.at(-1).value) {
        if (miterEvents.length >= 1024) return
        charge(12)
        miterEvents.push(frozen({ operationIndex: i, value: state.miter }))
      }
    }
    if (stack.length || pending !== undefined || groupDepth || row !== pathCount) return
    for (const scope of scopes) frozen(scope)
    for (const g of groups.values()) frozen(g)
    const packedPaths = frozen({
      count: pathCount,
      operationIndices,
      bounds,
      floors,
      clipIndices,
      scopeIndices,
      paintFlags,
      partitions,
      bytesPerPath: 54
    })
    const pathAt = (at) => {
      if (!Number.isSafeInteger(at) || at < 0 || at >= pathCount) return
      const i = operationIndices[at],
        a = o.argsArray[i],
        c = clips[clipIndices[at]]
      return frozen({
        operationIndex: i,
        row: at,
        originalArgs: a,
        originalPaths: a[1],
        originalPath: a[1]?.length === 1 ? a[1][0] : undefined,
        fullInk: frozen(Array.from(bounds.subarray(at * 4, at * 4 + 4))),
        floor: floors[at],
        clip: c.exactClip,
        exactClip: c.exactClip,
        potentialClipEnvelope: c.bounds,
        clipState: c,
        scope: scopeIndices[at],
        paints: (paintFlags[at] & 1) !== 0,
        empty: (paintFlags[at] & 2) !== 0
      })
    }
    const find = (i) => {
      let lo = 0,
        hi = pathCount - 1
      while (lo <= hi) {
        const at = (lo + hi) >>> 1,
          n = operationIndices[at]
        if (n === i) return at
        if (n < i) lo = at + 1
        else hi = at - 1
      }
      return -1
    }
    const paths = frozen({
      size: pathCount,
      at: pathAt,
      get: (i) => pathAt(find(i)),
      has: (i) => find(i) !== -1,
      *entries() {
        for (let n = 0; n < pathCount; n++) yield [operationIndices[n], pathAt(n)]
      },
      *keys() {
        yield* operationIndices
      },
      *values() {
        for (let n = 0; n < pathCount; n++) yield pathAt(n)
      },
      [Symbol.iterator]() {
        return this.entries()
      }
    })
    const miterAt = (i) => {
      let lo = 0,
        hi = miterEvents.length - 1
      while (lo < hi) {
        const at = (lo + hi + 1) >>> 1
        if (miterEvents[at].operationIndex <= i) lo = at
        else hi = at - 1
      }
      return miterEvents[lo].value
    }
    const strokeMargins = frozen({
      size: pathCount,
      get: (i) => (find(i) < 0 ? undefined : miterAt(i)),
      has: (i) => find(i) >= 0,
      *entries() {
        for (const i of operationIndices) yield [i, miterAt(i)]
      },
      [Symbol.iterator]() {
        return this.entries()
      }
    })
    const evidence = frozen({
        paths,
        texts: readonlyMap(texts),
        images: frozen(images),
        isolatedGroups: readonlyMap(groups),
        frames: readonlyMap(new Map())
      }),
      windows = columns.map(nativeCompositingByteWindow),
      typedDigest = () => {
        const h = createHash('sha256')
        for (let n = 0; n < columns.length; n++) {
          const old = windows[n],
            now = nativeCompositingByteWindow(columns[n])
          if (!old || !now || !Object.keys(old).every((key) => old[key] === now[key])) return
          h.update(new Uint8Array(now.buffer, now.byteOffset, now.byteLength))
        }
        return h.digest('hex')
      },
      initial = typedDigest(),
      current = () => {
        try {
          return !!initial && retained() && typedDigest() === initial
        } catch {
          return false
        }
      },
      data = frozen({
        o,
        v,
        evidence,
        packedPaths,
        clips: frozen(clips),
        scopes: frozen(scopes),
        patternStates: readonlyMap(patternStates),
        strokeMargins,
        current,
        stats: frozen({
          pathCount,
          pathScalars: scalarCount,
          maxPathScalars,
          maxGroupDepth,
          clipCount: clips.length,
          groups: groups.size,
          packedPathBytes: pathCount * 54,
          derivedLogicalPayloadBytes: payload,
          ordinaryMetadataHeapIncluded: false,
          miterChangePoints: miterEvents.length,
          patternStates: patternStates.size,
          scalarLimit: MAX_SCALARS,
          perPathScalarLimit: MAX_PATH_SCALARS,
          pathLimit: MAX_PATHS,
          payloadLimit: MAX_PAYLOAD,
          sourceAuthority: false,
          visibilityAuthority: false
        })
      })
    if (!current()) return
    const handle = frozen({})
    programs.set(handle, { page, tokens, context, data })
    return handle
  } catch {
    return
  }
}

export function nativeBoundedPixelProgramData(handle, page, tokens, context) {
  try {
    const p = programs.get(handle)
    return p?.page === page && p.tokens === tokens && p.context === context && p.data.current()
      ? p.data
      : undefined
  } catch {
    return
  }
}
