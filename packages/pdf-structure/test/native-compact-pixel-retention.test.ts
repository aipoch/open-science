import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { retainNativeRecoveryInputs, retainNativeCompactPixelInputs } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-figure-recovery-profile.mjs')).href
)

it('retains all original dense numeric point identities without changing the default object cap', () => {
  const points = Array.from({ length: 66000 }, (_, index) => [index / 10, -index / 10])
  const input = { pieces: [{ visiblePaintPoints: points }] }
  expect(retainNativeRecoveryInputs([input])).toBeUndefined()
  const current = retainNativeCompactPixelInputs([input])
  expect(current).toBeTypeOf('function')
  expect(current()).toBe(true)
  points[65000] = [...points[65000]]
  expect(current()).toBe(false)
})

it.each(['coordinate', 'negative-zero', 'descriptor', 'prototype', 'accessor', 'symbol', 'hole'])(
  'withdraws compact bindings on an original tuple mutation: %s',
  (kind) => {
    const tuple = [0, 2],
      input = { tuple }
    const current = retainNativeCompactPixelInputs([input])
    expect(current()).toBe(true)
    if (kind === 'coordinate') tuple[1]++
    if (kind === 'negative-zero') tuple[0] = -0
    if (kind === 'descriptor') Object.defineProperty(tuple, '0', { writable: false })
    if (kind === 'prototype') Object.setPrototypeOf(tuple, null)
    if (kind === 'accessor') Object.defineProperty(tuple, '0', { get: () => 0 })
    if (kind === 'symbol') Object.defineProperty(tuple, Symbol('foreign'), { value: 1 })
    if (kind === 'hole') Reflect.deleteProperty(tuple, '0')
    expect(current()).toBe(false)
  }
)

it('retains nonnumeric fields and aliases alongside compact tuples', () => {
  const tuple = [1, 2],
    input = { tuple, alias: tuple, text: 'original' }
  const current = retainNativeCompactPixelInputs([input])
  input.text = 'changed'
  expect(current()).toBe(false)
})

it('declines accessors and proxies without evaluating them', () => {
  let reads = 0
  const tuple = [1, 2]
  Object.defineProperty(tuple, '0', {
    get: () => {
      reads++
      return 1
    }
  })
  expect(retainNativeCompactPixelInputs([{ tuple }])).toBeUndefined()
  expect(retainNativeCompactPixelInputs([{ tuple: new Proxy([1, 2], {}) }])).toBeUndefined()
  expect(reads).toBe(0)
})

it('keeps a separate bound on original scan work', () => {
  expect(retainNativeCompactPixelInputs([Array.from({ length: 262145 }, () => [])])).toBeUndefined()
})

it('withdraws private typed bindings on an extra symbol without changing the ordinary retainer', () => {
  const coordinates = new Float64Array([1, 2]),
    input = { coordinates },
    current = retainNativeCompactPixelInputs([input])
  expect(current()).toBe(true)
  Object.defineProperty(coordinates, Symbol('foreign'), { value: 1 })
  expect(current()).toBe(false)
  expect(retainNativeCompactPixelInputs([input])).toBeUndefined()
})

it('keeps compact paint handles outside the ordinary certificate registry', async () => {
  const { anonymousPhysicalStrokeFrame } = await import(
    pathToFileURL(resolve('test/fixtures/physical-stroke-frame-figure.mjs')).href
  )
  const {
    createNativeCompactFigurePixelCertificate,
    nativeCompactFigurePixelCertificateData,
    nativeFigurePaintCertificateData
  } = await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
  )
  const args = anonymousPhysicalStrokeFrame().args,
    page = args[0],
    tokens = args[4],
    context = args[5],
    handle = createNativeCompactFigurePixelCertificate(page, tokens, context),
    details = nativeCompactFigurePixelCertificateData(handle, page, tokens, context)
  expect(details).toBeDefined()
  expect(nativeFigurePaintCertificateData(handle, page, tokens, context)).toBeUndefined()
  expect(nativeCompactFigurePixelCertificateData({}, page, tokens, context)).toBeUndefined()
  details.pieces[0].rect[0]++
  expect(nativeCompactFigurePixelCertificateData(handle, page, tokens, context)).toBeUndefined()
})
