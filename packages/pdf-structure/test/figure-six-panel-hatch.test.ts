import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { createCanvas } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { anonymousSixPanelHatchFigure } = await import(
  pathToFileURL(resolve('test/fixtures/six-panel-hatch-figure.mjs')).href
)
const crop = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-categorical-hatch.mjs')).href
)
const packets = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
it('recovers all six complete native panels and three own subcaptions from a legend-only crop', () => {
  const f = anonymousSixPanelHatchFigure(),
    a = f.args,
    before = JSON.stringify(a),
    plan = crop.nativeSixPanelHatchPixelCrop?.(...a, f.peers, a[1].rect)
  expect(plan).toBeDefined()
  expect(plan.rect[0]).toBeLessThan(40)
  expect(plan.rect[1]).toBeLessThan(40)
  expect(plan.rect[3]).toBeGreaterThan(205)
  expect(plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(a)).toBe(before)
  expect(crop.nativeCategoricalHatchPixelCrop(...a, f.peers, a[1].rect)).toBeUndefined()
})

it.each([
  'missing-frame',
  'column-shift',
  'third-bar',
  'extra-overlay',
  'partial-subcaption',
  'wrong-subcaption',
  'detached-subcaption',
  'foreign-caption',
  'table',
  'source-owner'
])('requires complete panels, ownership and subcaptions: %s', (mode) => {
  const f = anonymousSixPanelHatchFigure(mode),
    a = f.args
  expect(crop.nativeSixPanelHatchPixelCrop(...a, f.peers, a[1].rect)).toBeUndefined()
})

it('retains both original paints of a physical bar and protects the actual final PNG', () => {
  const f = anonymousSixPanelHatchFigure('overpaint'),
    a = f.args,
    plan = crop.nativeSixPanelHatchPixelCrop(...a, f.peers, a[1].rect),
    canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 3),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 3)
    )
  const png = canvas.toBuffer('image/png')
  expect(crop.nativeSixPanelHatchPixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
  expect(crop.nativeCategoricalHatchPixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
  expect(crop.nativeSixPanelHatchPixelPngSafe(structuredClone(plan), png, plan.rect, a[0])).toBe(
    false
  )
  const handle = packets.createNativeIdentityHatchGridPixelEvidence(a[0], a[4], a[5]),
    data = packets.nativeIdentityHatchGridPixelEvidenceData(handle, a[0], a[4], a[5])
  expect(data.paths).toHaveLength(20)
  expect(packets.nativeIdentityHatchPixelEvidenceData(handle, a[0], a[4], a[5])).toBeUndefined()
  expect(packets.nativeSavedUncoloredPixelEvidenceData(handle, a[0], a[4], a[5])).toBeUndefined()
  const o = a[5].operators,
    at = o.fnArray.indexOf(OPS.setLineWidth)
  o.argsArray[at][0] *= 2
  expect(crop.nativeSixPanelHatchPixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
  canvas.width = canvas.height = 1
})

it('declines a lower-resolution final PNG rather than weakening the native ink protection', () => {
  const f = anonymousSixPanelHatchFigure(),
    a = f.args,
    plan = crop.nativeSixPanelHatchPixelCrop(...a, f.peers, a[1].rect),
    canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 0.5),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 0.5)
    )
  expect(
    crop.nativeSixPanelHatchPixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, a[0])
  ).toBe(false)
  canvas.width = canvas.height = 1
})
