import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { compactNativePixelArrayBindings: bind } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-compact-array-bindings.mjs')).href
)
const { retainNativeRecoveryInputs, retainNativeArrayPixelInputs } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-figure-recovery-profile.mjs')).href
)

it('packs many original tiny arrays while retaining all actual child roots', () => {
  const child = { native: new Uint8Array([1, 2, 3]) },
    arrays = Array.from({ length: 70000 }, (_, i) => [i, child, 'resource']),
    root = { arrays },
    proof = bind([root])
  expect(retainNativeRecoveryInputs([root])).toBeUndefined()
  expect(proof.current()).toBe(true)
  expect(proof.frontier).toContain(child)
  expect(proof.stats).toMatchObject({
    compactArrays: 70000,
    compactSlots: 210000,
    noncompactObjects: 4,
    originalTypedBytes: 3,
    newTypedHashIdentityBytes: 0,
    ordinaryDescriptorStorageIncluded: false
  })
  expect(proof.stats.bindingBytes).toBe(64 + 70000 * (22 + 27) + 8 + 12 + 'resource'.length * 2)
  expect(proof.contains(child)).toBe(false)
  expect(proof.contains(arrays[0])).toBe(true)
  arrays[69999][1] = { ...child }
  expect(proof.current()).toBe(false)
})

it.each([
  'number',
  'negative-zero',
  'string',
  'reference',
  'descriptor',
  'enumerable',
  'configurable',
  'length',
  'length-flags',
  'prototype',
  'symbol',
  'accessor'
])('withdraws a changed compact binding: %s', (fault) => {
  const child = { value: 1 },
    array: unknown[] = [1, -0, 'resource', child],
    proof = bind([array])
  expect(proof.current()).toBe(true)
  if (fault === 'number') array[0] = 2
  if (fault === 'negative-zero') array[1] = 0
  if (fault === 'string') array[2] = 'changed'
  if (fault === 'reference') array[3] = { ...child }
  if (fault === 'descriptor') Object.defineProperty(array, '0', { writable: false })
  if (fault === 'enumerable') Object.defineProperty(array, '0', { enumerable: false })
  if (fault === 'configurable') Object.defineProperty(array, '0', { configurable: false })
  if (fault === 'length') array.push(2)
  if (fault === 'length-flags') Object.defineProperty(array, 'length', { writable: false })
  if (fault === 'prototype') Object.setPrototypeOf(array, null)
  if (fault === 'symbol') Object.defineProperty(array, Symbol('extra'), { value: 1 })
  if (fault === 'accessor')
    Object.defineProperty(array, '0', {
      get: () => {
        throw Error('Getter must not run')
      }
    })
  expect(proof.current()).toBe(false)
})

it('requires the ordinary retainer for every mutable child and original typed byte', () => {
  const typed = new Uint8Array([1, 2, 3]),
    child = { typed },
    array = [1, child],
    proof = bind([array]),
    ordinary = retainNativeRecoveryInputs(proof.frontier)
  expect(proof.current()).toBe(true)
  expect(ordinary()).toBe(true)
  typed[1] = 9
  expect(proof.current()).toBe(true)
  expect(ordinary()).toBe(false)
})

it('keeps cycles, nested compact parents and aliases without losing ordinary descendants', () => {
  const child = { data: new Float64Array([2]) },
    first: unknown[] = ['root'],
    second: unknown[] = [first, child]
  first.push(second, child)
  const proof = bind([first])
  expect(proof.current()).toBe(true)
  expect(proof.frontier).toEqual([second, child, first])
  expect(proof.stats.scannedObjects).toBe(4)
  expect(proof.stats.originalTypedBytes).toBe(8)
})

it('does not execute getters or compact exotic, sparse or extra-key arrays', () => {
  let calls = 0
  const accessor = [1, 2]
  Object.defineProperty(accessor, '1', {
    get: () => {
      calls++
      return 2
    }
  })
  expect(bind([accessor])).toBeUndefined()
  expect(calls).toBe(0)
  expect(bind([new Proxy([1], {})])).toBeUndefined()
  expect(bind([new DataView(new ArrayBuffer(8))])).toBeUndefined()
  const sparse = Array(2),
    extra = Object.assign([1], { extra: true }),
    subclass = new (class extends Array {})(1, 2)
  for (const input of [sparse, extra, subclass]) expect(bind([input]).contains(input)).toBe(false)
})

it('enforces separate binding, original typed payload, noncompact and total scan bounds', () => {
  expect(bind([['x'.repeat(4 * 1024 * 1024)]])).toBeUndefined()
  expect(bind([[new Uint8Array(8 * 1024 * 1024 + 1)]])).toBeUndefined()
  expect(bind([Array.from({ length: 65537 }, () => ({ value: 1 }))])).toBeUndefined()
  expect(bind([Array.from({ length: 262145 }, () => [])])).toBeUndefined()
})

it.each(['byte', 'symbol', 'own-key', 'child-descriptor', 'child-value'])(
  'retains complete ordinary child resources and private typed own keys: %s',
  (fault) => {
    const typed = new Float64Array([1, 2]),
      child = { typed, value: 'original' },
      input = { arrays: Array.from({ length: 66000 }, () => ['native', child]) }
    expect(retainNativeRecoveryInputs([input])).toBeUndefined()
    const current = retainNativeArrayPixelInputs([input])
    expect(current()).toBe(true)
    if (fault === 'byte') typed[1] = 3
    if (fault === 'symbol') Object.defineProperty(typed, Symbol('foreign'), { value: 1 })
    if (fault === 'own-key') Object.defineProperty(typed, 'foreign', { value: 1 })
    if (fault === 'child-descriptor') Object.defineProperty(child, 'value', { enumerable: false })
    if (fault === 'child-value') child.value = 'changed'
    expect(current()).toBe(false)
  }
)

it('keeps array-bound pixel handles outside ordinary and numeric-tuple registries', async () => {
  const { anonymousPhysicalStrokeFrame } = await import(
      pathToFileURL(resolve('test/fixtures/physical-stroke-frame-figure.mjs')).href
    ),
    {
      createNativeArrayBoundFigurePixelCertificate,
      createNativeFigurePaintCertificate,
      createNativeCompactFigurePixelCertificate,
      nativeArrayBoundFigurePixelCertificateData,
      nativeFigurePaintCertificateData,
      nativeCompactFigurePixelCertificateData
    } = await import(
      pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
    ),
    args = anonymousPhysicalStrokeFrame().args,
    page = args[0],
    tokens = args[4],
    context = args[5],
    storage = Array.from({ length: 66000 }, () => ['native-pixel']),
    populated = Object.assign(context, { privateFixtureStorage: storage }),
    handle = createNativeArrayBoundFigurePixelCertificate(page, tokens, populated),
    data = nativeArrayBoundFigurePixelCertificateData(handle, page, tokens, populated)
  expect(createNativeFigurePaintCertificate(page, tokens, populated)).toBeUndefined()
  expect(createNativeCompactFigurePixelCertificate(page, tokens, populated)).toBeUndefined()
  expect(data).toBeDefined()
  expect(nativeFigurePaintCertificateData(handle, page, tokens, context)).toBeUndefined()
  expect(nativeCompactFigurePixelCertificateData(handle, page, tokens, context)).toBeUndefined()
  expect(nativeArrayBoundFigurePixelCertificateData({}, page, tokens, context)).toBeUndefined()
  data.pieces[0].rect[0]++
  expect(nativeArrayBoundFigurePixelCertificateData(handle, page, tokens, context)).toBeUndefined()
})
