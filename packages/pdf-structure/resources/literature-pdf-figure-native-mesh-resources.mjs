/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { types } from 'node:util'
import { OPS, Util, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'

const captures = new WeakMap(),
  maxBytes = 2 * 1024 * 1024,
  maxResources = 4096,
  maxSlots = 262144,
  maxTriangles = 131072
const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const invertible = (a) => finite(a, 6) && a[0] * a[3] - a[1] * a[2] !== 0

function own(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(descriptors).some(
      (k) => typeof k === 'symbol' || !Object.hasOwn(descriptors[k], 'value')
    )
  )
    return
  return Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.value]))
}

function shallowBinding(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(descriptors),
    prototype = Object.getPrototypeOf(value)
  if (keys.some((key) => !Object.hasOwn(descriptors[key], 'value'))) return
  return () => {
    const now = Object.getOwnPropertyDescriptors(value),
      currentKeys = Reflect.ownKeys(now)
    return (
      Object.getPrototypeOf(value) === prototype &&
      currentKeys.length === keys.length &&
      keys.every((key, i) => {
        const d = now[key],
          old = descriptors[key]
        return (
          currentKeys[i] === key &&
          d &&
          Object.hasOwn(d, 'value') &&
          Object.is(d.value, old.value) &&
          d.writable === old.writable &&
          d.enumerable === old.enumerable &&
          d.configurable === old.configurable
        )
      })
    )
  }
}

function plainArray(value, length) {
  return (
    !types.isProxy(value) &&
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    value.length === length &&
    own(value) &&
    Reflect.ownKeys(value).length === length + 1 &&
    Array.from({ length }, (_, i) => Object.hasOwn(value, i)).every(Boolean)
  )
}

function typed(value, prototype, limit) {
  return (
    value &&
    !types.isProxy(value) &&
    Object.getPrototypeOf(value) === prototype &&
    value.length > 0 &&
    value.length <= limit &&
    Object.getPrototypeOf(value.buffer) === ArrayBuffer.prototype &&
    Reflect.ownKeys(value).length === value.length
  )
}

// The pinned renderer can sample outside the triangle vertices when making
// its mesh canvas. These bounds validate the resource, never bound its paint:
// CanvasGraphics.fill preserves the complete original destination path.
function mesh(ir) {
  if (!plainArray(ir, 8) || ir[0] !== 'Mesh' || ir[1] !== 4) return
  const [, , coords, colors, figures, bounds, bbox, background] = ir
  if (
    !typed(coords, Float32Array.prototype, maxSlots * 2) ||
    coords.length % 2 ||
    !coords.every(Number.isFinite) ||
    !typed(colors, Uint8Array.prototype, maxSlots * 3) ||
    colors.length % 3 ||
    !Array.isArray(figures) ||
    !figures.length ||
    figures.length > 128 ||
    !plainArray(figures, figures.length) ||
    !plainArray(bounds, 4) ||
    !finite(bounds, 4) ||
    bounds[0] >= bounds[2] ||
    bounds[1] >= bounds[3] ||
    bbox !== null ||
    background !== null
  )
    return
  let triangles = 0,
    bytes = 256 + coords.byteLength + colors.byteLength
  for (const figure of figures) {
    const f = own(figure)
    if (
      !f ||
      Object.getPrototypeOf(figure) !== Object.prototype ||
      Reflect.ownKeys(f).sort().join(',') !== 'colors,coords,type' ||
      f.type !== 1 ||
      !typed(f.coords, Int32Array.prototype, maxTriangles * 3) ||
      !typed(f.colors, Int32Array.prototype, maxTriangles * 3) ||
      f.coords.length !== f.colors.length ||
      f.coords.length % 3 ||
      f.coords.some((n) => n < 0 || n % 2 || n + 1 >= coords.length) ||
      f.colors.some((n) => n < 0 || n % 3 || n + 2 >= colors.length)
    )
      return
    triangles += f.coords.length / 3
    bytes += 256 + f.coords.byteLength + f.colors.byteLength
    if (triangles > maxTriangles || bytes > maxBytes) return
  }
  // Float32 conversion can move a native vertex just across the double bound.
  // The renderer allocates floor/ceil bounds, so validate that full envelope.
  for (let i = 0; i < coords.length; i += 2)
    if (
      coords[i] < Math.floor(bounds[0]) ||
      coords[i] > Math.ceil(bounds[2]) ||
      coords[i + 1] < Math.floor(bounds[1]) ||
      coords[i + 1] > Math.ceil(bounds[3])
    )
      return
  return { bytes, triangles, slots: coords.length / 2 }
}

function exactRectangle(a) {
  const p = a?.[1]?.[0],
    b = a?.[2]
  if (
    !Array.isArray(a) ||
    a.length !== 3 ||
    a[0] !== OPS.fill ||
    !Array.isArray(a[1]) ||
    a[1].length !== 1 ||
    !finite(p, 13) ||
    !finite(b, 4) ||
    p[0] !== 0 ||
    p[3] !== 1 ||
    p[6] !== 1 ||
    p[9] !== 1 ||
    p[12] !== 4 ||
    !(b[0] < b[2] && b[1] < b[3])
  )
    return false
  const points = [
    [p[1], p[2]],
    [p[4], p[5]],
    [p[7], p[8]],
    [p[10], p[11]]
  ]
  return (
    new Set(points.map((q) => q.join(','))).size === 4 &&
    points.every(([x, y]) => (x === b[0] || x === b[2]) && (y === b[1] || y === b[3])) &&
    points.every((q, i) => {
      const next = points[(i + 1) % 4]
      return (q[0] === next[0]) !== (q[1] === next[1])
    })
  )
}

// Resource stores have private fields. Bind their complete descriptor chain,
// then use the captured get method without invoking newly installed getters.
function storeBinding(store) {
  const chain = []
  let current = store,
    get
  for (let depth = 0; current && depth < 5; depth++) {
    if (types.isProxy(current)) return
    const descriptors = Object.getOwnPropertyDescriptors(current),
      keys = Reflect.ownKeys(descriptors),
      parent = Object.getPrototypeOf(current),
      object = current
    if (
      current !== Object.prototype &&
      keys.some((key) => !Object.hasOwn(descriptors[key], 'value'))
    )
      return
    if (!get && descriptors.get) get = descriptors.get.value
    chain.push(() => {
      const now = Object.getOwnPropertyDescriptors(object)
      return (
        Object.getPrototypeOf(object) === parent &&
        Reflect.ownKeys(now).length === keys.length &&
        keys.every((key, i) => {
          const d = now[key],
            old = descriptors[key]
          return (
            Reflect.ownKeys(now)[i] === key &&
            d &&
            Object.hasOwn(d, 'value') === Object.hasOwn(old, 'value') &&
            (Object.hasOwn(old, 'value')
              ? d.value === old.value && d.writable === old.writable
              : d.get === old.get && d.set === old.set) &&
            d.enumerable === old.enumerable &&
            d.configurable === old.configurable
          )
        })
      )
    })
    current = parent
  }
  if (current || typeof get !== 'function') return
  return { current: () => chain.every((same) => same()), get: (id) => get.call(store, id) }
}

// Call only from the trusted native render observer. This handle attests a
// resource inventory, not a page/crop/Source. Its observer must independently
// brand the exact captured context before any pixel purpose can consume it.
export function captureNativeMesh4PixelResources(renderTask, operators, budget) {
  try {
    if (version !== '5.4.624' || !Number.isFinite(budget) || budget <= 0) return
    const renderCurrent = shallowBinding(renderTask),
      task = renderCurrent && renderTask._internalRenderTask,
      taskCurrent = shallowBinding(task),
      raw = taskCurrent ? task.operatorList : undefined,
      rawCurrent = shallowBinding(raw),
      keep = retainNativeRecoveryInputs([operators]),
      rawFns = rawCurrent ? raw.fnArray : undefined,
      rawArgs = rawCurrent ? raw.argsArray : undefined,
      rawFnCurrent = retainNativeRecoveryInputs([rawFns])
    if (
      !keep ||
      !renderCurrent ||
      !taskCurrent ||
      !rawCurrent ||
      !rawFnCurrent ||
      !raw ||
      !Array.isArray(rawFns) ||
      !plainArray(rawArgs, rawFns.length) ||
      rawFns.length !== rawArgs.length ||
      rawFns.length > 100000 ||
      operators.fnArray.length !== rawFns.length ||
      operators.fnArray.some((op, i) => op !== rawFns[i])
    )
      return
    const originalArgs = rawArgs.slice()
    let bytes = 256 + rawFns.length * 8,
      triangles = 0,
      slots = 0,
      state = { matrix: [1, 0, 0, 1, 0, 0], base: [1, 0, 0, 1, 0, 0], alpha: 1, fill: null }
    const limit = Math.min(maxBytes, budget),
      resources = [],
      states = [],
      stack = [],
      stores = new Map(),
      seen = new Map(),
      rawUses = []
    for (let i = 0; i < operators.fnArray.length; i++) {
      const op = operators.fnArray[i],
        a = operators.argsArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        if (stack.length >= 64) return
        stack.push({
          op,
          begin: i,
          state: { ...state, matrix: [...state.matrix], base: [...state.base] }
        })
        if (op === OPS.paintFormXObjectBegin) {
          if (!Array.isArray(a) || a.length !== 2 || !finite(a[1], 4)) return
          if (a[0] !== null) {
            if (!invertible(a[0])) return
            state.matrix = Util.transform(state.matrix, a[0])
          }
          state.base = [...state.matrix]
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        const last = stack.pop()
        if (!last || last.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
        state = last.state
      } else if (op === OPS.transform) {
        if (!invertible(a)) return
        state.matrix = Util.transform(state.matrix, a)
        if (!invertible(state.matrix)) return
      } else if (op === OPS.setGState) {
        if (
          !Array.isArray(a?.[0]) ||
          a[0].some(
            (e) =>
              !Array.isArray(e) ||
              e.length !== 2 ||
              !(
                (['ca', 'CA'].includes(e[0]) && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1) ||
                (e[0] === 'BM' && e[1] === 'source-over') ||
                (e[0] === 'SMask' && e[1] === false)
              )
          )
        )
          return
        for (const [key, value] of a[0]) if (key === 'ca') state.alpha = value
      } else if (op === OPS.setFillRGBColor) state.fill = null
      else if (op === OPS.setFillColorN) {
        const args = rawArgs[i],
          form = stack.findLast((s) => s.op === OPS.paintFormXObjectBegin)
        if (
          !plainArray(a, 3) ||
          a[0] !== 'Shading' ||
          typeof a[1] !== 'string' ||
          !a[1] ||
          !invertible(a[2]) ||
          !form ||
          state.alpha !== 1 ||
          operators.fnArray[i + 1] !== OPS.constructPath ||
          !exactRectangle(operators.argsArray[i + 1]) ||
          !retainNativeRecoveryInputs([args]) ||
          !Array.isArray(args) ||
          JSON.stringify(args) !== JSON.stringify(a)
        )
          return
        const store = a[1].startsWith('g_') ? task.commonObjs : task.objs
        if (!stores.has(store)) stores.set(store, storeBinding(store))
        const binding = stores.get(store)
        if (!binding?.current()) return
        const ir = binding.get(a[1]),
          existing = seen.get(a[1])
        if (existing && existing.ir !== ir) return
        if (!existing) {
          const info = mesh(ir)
          if (!info || resources.length >= maxResources) return
          bytes += info.bytes + 256 + a[1].length * 2
          triangles += info.triangles
          slots += info.slots
          if (bytes > limit || triangles > maxTriangles || slots > maxSlots) return
          const entry = { id: a[1], ir, store }
          resources.push(entry)
          seen.set(a[1], entry)
        }
        bytes += 512
        if (bytes > limit) return
        state.fill = i + 1
        rawUses.push(args)
        states.push({
          kind: 'native-mesh4-pixel-resource',
          operationIndex: i,
          fillOperationIndex: i + 1,
          resourceId: a[1],
          patternMatrix: [...a[2]],
          formBegin: form.begin,
          formBaseTransform: [...state.base],
          fillTransform: [...state.matrix]
        })
      } else if ([OPS.setStrokeColorN, OPS.shadingFill, OPS.beginGroup, OPS.endGroup].includes(op))
        return
      else if (
        state.fill !== null &&
        ((op === OPS.constructPath && a?.[0] !== OPS.endPath && state.fill !== i) ||
          op === OPS.showText)
      )
        return
    }
    if (stack.length || !resources.length || bytes > limit) return
    let sealed = false
    const details = {
        states,
        resources: resources.map(({ id, ir }) => ({ id, ir })),
        bytes,
        triangles,
        slots
      },
      allCurrent = retainNativeRecoveryInputs([operators, details, rawUses]),
      handle = Object.freeze({}),
      retainedCurrent = () =>
        rawCurrent() &&
        keep() &&
        rawFnCurrent() &&
        allCurrent?.() &&
        raw.fnArray === rawFns &&
        raw.argsArray === rawArgs &&
        rawFns.length === operators.fnArray.length &&
        rawArgs.length === originalArgs.length &&
        Object.getPrototypeOf(rawArgs) === Array.prototype &&
        Reflect.ownKeys(rawArgs).length === originalArgs.length + 1 &&
        originalArgs.every((a, i) => {
          const d = Object.getOwnPropertyDescriptor(rawArgs, String(i))
          return (
            d &&
            Object.hasOwn(d, 'value') &&
            d.value === a &&
            d.enumerable === true &&
            d.writable === true &&
            d.configurable === true &&
            rawFns[i] === operators.fnArray[i]
          )
        }),
      liveCurrent = () =>
        renderCurrent() &&
        taskCurrent() &&
        [...stores.values()].every((s) => s.current()) &&
        resources.every((r) => stores.get(r.store).get(r.id) === r.ir),
      current = () => retainedCurrent() && (sealed || liveCurrent()),
      seal = (originalRender, originalOperators) => {
        if (
          sealed ||
          originalRender !== renderTask ||
          originalOperators !== operators ||
          !retainedCurrent() ||
          !liveCurrent()
        )
          return false
        sealed = true
        return true
      }
    if (!allCurrent || !current()) return
    captures.set(handle, { operators, details, current, seal })
    return handle
  } catch {
    return
  }
}

export function nativeMesh4PixelResourceData(handle, operators) {
  try {
    const capture = captures.get(handle)
    return capture?.operators === operators && capture.current() ? capture.details : undefined
  } catch {
    return
  }
}

// Only the trusted render observer may transfer this completed render witness
// before its ordinary resource cleanup. Original IR, buffers, descriptors and
// both original/snapshot streams remain bound after that single transition.
export function sealNativeMesh4PixelResources(handle, renderTask, operators) {
  try {
    return captures.get(handle)?.seal(renderTask, operators) === true
  } catch {
    return false
  }
}
