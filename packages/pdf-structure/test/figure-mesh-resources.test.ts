/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const { captureNativeMesh4PixelResources, nativeMesh4PixelResourceData } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-mesh-resources.mjs')).href
)

function fixture() {
  const ir = [
    'Mesh',
    4,
    new Float32Array([0, 0, 8, 0, 0, 6, 8, 0, 8, 6, 0, 6]),
    new Uint8Array([
      200, 100, 90, 100, 200, 90, 90, 100, 200, 100, 200, 90, 90, 200, 100, 90, 100, 200
    ]),
    [
      {
        type: 1,
        coords: new Int32Array([0, 2, 4, 6, 8, 10]),
        colors: new Int32Array([0, 3, 6, 9, 12, 15])
      }
    ],
    [0, 0, 8, 6],
    null,
    null
  ]
  const fnArray = [
    OPS.save,
    OPS.transform,
    OPS.paintFormXObjectBegin,
    OPS.transform,
    OPS.setFillColorN,
    OPS.constructPath,
    OPS.constructPath,
    OPS.paintFormXObjectEnd,
    OPS.restore
  ]
  const argsArray = [
    null,
    [1, 0, 0, 1, 30, 40],
    [null, [0, 0, 12, 10]],
    [1, 0, 0, 1, -2, -3],
    ['Shading', 'mesh', [1, 0, 0, 1, -2, -3]],
    [
      OPS.fill,
      [new Float32Array([0, 2, 3, 1, 10, 3, 1, 10, 9, 1, 2, 9, 4])],
      new Float32Array([2, 3, 10, 9])
    ],
    [OPS.endPath, [null], null],
    [],
    null
  ]
  const raw = { fnArray, argsArray },
    snapshot = structuredClone(raw),
    resources = new Map([['mesh', ir]]),
    store = { get: (id: string) => resources.get(id) },
    render = { _internalRenderTask: { operatorList: raw, objs: store, commonObjs: store } }
  return { ir, raw, snapshot, resources, store, render }
}

it('retains two anonymous native mesh triangles and the distinct Form base/paint transform', () => {
  const f = fixture(),
    handle = captureNativeMesh4PixelResources(f.render, f.snapshot, 2 ** 21),
    data = nativeMesh4PixelResourceData(handle, f.snapshot)
  expect(data).toBeDefined()
  expect(data.triangles).toBe(2)
  expect(data.states[0].formBaseTransform).toEqual([1, 0, 0, 1, 30, 40])
  expect(data.states[0].fillTransform).toEqual([1, 0, 0, 1, 28, 37])
  expect(data.resources[0].ir).toBe(f.ir)
  expect(data.sourceItems).toBeUndefined()
  expect(nativeMesh4PixelResourceData({}, f.snapshot)).toBeUndefined()
  expect(nativeMesh4PixelResourceData(handle, structuredClone(f.snapshot))).toBeUndefined()
})

it.each([
  'kind',
  'index',
  'nonfinite',
  'background',
  'extra',
  'rectangle',
  'missing-form',
  'budget'
])('declines malformed or unsupported %s evidence', (mode) => {
  const f = fixture()
  if (mode === 'kind') f.ir[0] = 'Dummy'
  if (mode === 'index') (f.ir[4] as { coords: Int32Array }[])[0].coords[0] = 1
  if (mode === 'nonfinite') (f.ir[2] as Float32Array)[0] = NaN
  if (mode === 'background') f.ir[7] = [255, 255, 255]
  if (mode === 'extra') Object.defineProperty(f.ir, 'extra', { value: true })
  if (mode === 'rectangle') (f.snapshot.argsArray[5]![1] as Float32Array[])[0][4] = 9
  if (mode === 'missing-form') f.snapshot.fnArray[2] = OPS.save
  expect(
    captureNativeMesh4PixelResources(f.render, f.snapshot, mode === 'budget' ? 32 : 2 ** 21)
  ).toBeUndefined()
})

it.each([
  'coordinate',
  'descriptor',
  'lookup',
  'method',
  'stream',
  'output',
  'task',
  'raw-getter',
  'fn-getter'
])('withdraws changed %s evidence', (mode) => {
  const f = fixture(),
    handle = captureNativeMesh4PixelResources(f.render, f.snapshot, 2 ** 21)
  expect(handle).toBeDefined()
  if (mode === 'coordinate') (f.ir[2] as Float32Array)[0] = 1
  if (mode === 'descriptor') Object.defineProperty(f.ir, '0', { writable: false })
  if (mode === 'lookup') f.resources.set('mesh', structuredClone(f.ir))
  if (mode === 'method') f.store.get = () => f.ir
  if (mode === 'stream') f.raw.argsArray[3] = [1, 0, 0, 1, -2, -3]
  if (mode === 'output') nativeMesh4PixelResourceData(handle, f.snapshot).states[0].formBegin = 0
  if (mode === 'task') f.render._internalRenderTask.operatorList = structuredClone(f.raw)
  let getterCalled = false
  if (mode === 'raw-getter')
    Object.defineProperty(f.raw.argsArray, '3', {
      get: () => {
        getterCalled = true
        return null
      }
    })
  if (mode === 'fn-getter')
    Object.defineProperty(f.raw.fnArray, '3', {
      get: () => {
        getterCalled = true
        return OPS.transform
      }
    })
  expect(nativeMesh4PixelResourceData(handle, f.snapshot)).toBeUndefined()
  expect(getterCalled).toBe(false)
})

it('declines getters without evaluating them', () => {
  const f = fixture()
  let called = false
  Object.defineProperty(f.ir, '0', {
    get: () => {
      called = true
      return 'Mesh'
    }
  })
  expect(captureNativeMesh4PixelResources(f.render, f.snapshot, 2 ** 21)).toBeUndefined()
  expect(called).toBe(false)
})

it('declines a replaced proxy IR without executing its traps', () => {
  const f = fixture()
  let called = false
  f.resources.set(
    'mesh',
    new Proxy(f.ir, {
      getPrototypeOf() {
        called = true
        return Array.prototype
      },
      get() {
        called = true
        return undefined
      }
    })
  )
  expect(captureNativeMesh4PixelResources(f.render, f.snapshot, 2 ** 21)).toBeUndefined()
  expect(called).toBe(false)
})
