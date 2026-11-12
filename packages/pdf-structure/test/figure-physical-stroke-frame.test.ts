import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { anonymousPhysicalStrokeFrame } = await import(
  pathToFileURL(resolve('test/fixtures/physical-stroke-frame-figure.mjs')).href
)
const {
  nativePhysicalFramePixelCrop,
  nativePhysicalFramePixelPngSafe,
  nativeClosedProgramPixelCrop,
  nativeClosedPaintPixelCrop
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-closed-program.mjs')).href
)
const { collectClosedFigureFrames } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)

it('recovers a physically closed native text pipeline without changing centerline tolerance', () => {
  const a = anonymousPhysicalStrokeFrame().args,
    before = JSON.stringify(a),
    plan = nativePhysicalFramePixelCrop?.(...a)
  expect(plan).toBeDefined()
  expect(plan.rect[0]).toBeLessThan(40)
  expect(plan.rect[2]).toBeGreaterThan(360)
  expect(plan.sourceItems).toBeUndefined()
  expect(collectClosedFigureFrames(a[5].operators, a[5].viewport)).toEqual([])
  expect(nativeClosedProgramPixelCrop(...a)).toBeUndefined()
  expect(nativeClosedPaintPixelCrop(...a)).toBeUndefined()
  expect(JSON.stringify(a)).toBe(before)
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 3),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 3)
  )
  expect(nativePhysicalFramePixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, a[0])).toBe(
    true
  )
  expect(
    nativePhysicalFramePixelPngSafe(
      structuredClone(plan),
      canvas.toBuffer('image/png'),
      plan.rect,
      a[0]
    )
  ).toBe(false)
  canvas.width = canvas.height = 1
})

it.each([
  'open-corner',
  'missing-side',
  'hairline',
  'dashed',
  'intervening-text',
  'foreign-text',
  'foreign-caption',
  'table',
  'glyph-outside',
  'unknown-ink'
])('declines an unclosed or contaminated physical frame: %s', (mode) =>
  expect(nativePhysicalFramePixelCrop(...anonymousPhysicalStrokeFrame(mode).args)).toBeUndefined()
)

it('binds original paint state and rechecks the actual final PNG scale', () => {
  const a = anonymousPhysicalStrokeFrame().args,
    plan = nativePhysicalFramePixelCrop(...a),
    canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 0.25),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 0.25)
    )
  expect(nativePhysicalFramePixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, a[0])).toBe(
    false
  )
  canvas.width = Math.ceil((plan.rect[2] - plan.rect[0]) * 3)
  canvas.height = Math.ceil((plan.rect[3] - plan.rect[1]) * 3)
  const png = canvas.toBuffer('image/png')
  expect(nativePhysicalFramePixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
  const o = a[5].operators
  o.argsArray[o.fnArray.indexOf(OPS.setLineWidth)][0] *= 2
  expect(nativePhysicalFramePixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
  canvas.width = canvas.height = 1
})

it('keeps unknown glyph programs, colored strokes, and published crops outside this purpose', () => {
  const missing = anonymousPhysicalStrokeFrame().args
  missing[5].glyphBounds = []
  expect(nativePhysicalFramePixelCrop(...missing)).toBeUndefined()
  const colored = anonymousPhysicalStrokeFrame().args
  colored[5].operators.argsArray[colored[5].operators.fnArray.indexOf(OPS.setStrokeRGBColor)][0] =
    '#ffffff'
  expect(nativePhysicalFramePixelCrop(...colored)).toBeUndefined()
  const existing = anonymousPhysicalStrokeFrame().args
  existing[1].rect = [40, 45, 360, 115]
  expect(nativePhysicalFramePixelCrop(...existing)).toBeUndefined()
})
