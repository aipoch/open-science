import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas } from '@napi-rs/canvas'

const { nativeFillStrokeGlyphEnvelope } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-stroked-text.mjs')).href
)
const { anonymousFillStrokeTextFigure } = await import(
  pathToFileURL(resolve('test/fixtures/fill-stroke-text-figure.mjs')).href
)
const { nativeFillStrokeTextInkPacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const {
  nativeFillStrokeTextPixelCrop,
  nativeFillStrokeTextPixelPngSafe,
  nativeClosedProgramPixelCrop,
  nativeClosedPaintPixelCrop,
  nativeSavedPaintPixelCrop
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-closed-program.mjs')).href
)

it('recovers complete outlined native labels through a separate image-only proof', () => {
  const a = anonymousFillStrokeTextFigure().args,
    before = JSON.stringify(a),
    plan = nativeFillStrokeTextPixelCrop(...a)
  expect(plan?.rect[0]).toBeLessThan(50)
  expect(plan?.rect[3]).toBeGreaterThan(188)
  expect(plan?.sourceItems).toBeUndefined()
  expect(JSON.stringify(a)).toBe(before)
  expect(nativeClosedProgramPixelCrop(...a)).toBeUndefined()
  expect(nativeClosedPaintPixelCrop(...a)).toBeUndefined()
  expect(nativeSavedPaintPixelCrop(...a)).toBeUndefined()
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 3),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 3)
  )
  try {
    const png = canvas.toBuffer('image/png')
    expect(nativeFillStrokeTextPixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
    expect(nativeFillStrokeTextPixelPngSafe(structuredClone(plan), png, plan.rect, a[0])).toBe(
      false
    )
    const state = a[5].operators.argsArray[a[5].operators.fnArray.indexOf(OPS.setLineWidth)]
    state[0] *= 2
    expect(nativeFillStrokeTextPixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
  } finally {
    canvas.width = canvas.height = 1
  }
})

it.each(['foreign-paint', 'foreign-text', 'table', 'caption', 'open-save', 'outlines'])(
  'declines incomplete or contaminated outlined programs: %s',
  (mode) => {
    expect(
      nativeFillStrokeTextPixelCrop(...anonymousFillStrokeTextFigure(mode).args)
    ).toBeUndefined()
  }
)

it('keeps complete measured images in the same Form and binds their original hash', () => {
  const a = anonymousFillStrokeTextFigure('image').args,
    plan = nativeFillStrokeTextPixelCrop(...a)
  expect(plan?.rect[2]).toBeGreaterThan(320)
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 3),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 3)
  )
  try {
    const png = canvas.toBuffer('image/png')
    expect(nativeFillStrokeTextPixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
    a[0].graphicsBounds.at(-1).imageHash = 'd'.repeat(64)
    expect(nativeFillStrokeTextPixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
  } finally {
    canvas.width = canvas.height = 1
  }
})

it('retains existing bounded normal-alpha paint without allowing translucent text', () => {
  expect(
    nativeFillStrokeTextPixelCrop(...anonymousFillStrokeTextFigure('owned-alpha').args)
  ).toBeDefined()
  const a = anonymousFillStrokeTextFigure().args,
    o = a[5].operators,
    at = o.fnArray.indexOf(OPS.beginText)
  o.fnArray.splice(at, 0, OPS.setGState)
  o.argsArray.splice(at, 0, [[['ca', 0.9]]])
  expect(nativeFillStrokeTextPixelCrop(...a)).toBeUndefined()
})

it('excludes foreign stroke paint even when its native fill outline is outside the crop', () => {
  const a = anonymousFillStrokeTextFigure('foreign-stroke').args,
    packet = nativeFillStrokeTextInkPacket(a[0], a[4], a[5], [a[4][0].sourceItem]),
    foreign = packet?.glyphs.find((g: { text: string }) => g.text === 'Foreign sentence.')
  expect(a[4].find((t: { text: string }) => t.text === 'Foreign sentence.').rect[0]).toBe(300)
  expect(foreign?.fillStrokeText.ink[0]).toBe(300)
  expect(foreign?.ink[0]).toBeLessThan(280)
  expect(nativeFillStrokeTextPixelCrop(...a)).toBeUndefined()
})

it('withdraws the plan when a final low-resolution PNG cannot protect its strokes', () => {
  const a = anonymousFillStrokeTextFigure().args,
    o = a[5].operators
  o.argsArray[o.fnArray.indexOf(OPS.setLineWidth)][0] = 0.01
  const plan = nativeFillStrokeTextPixelCrop(...a)
  expect(plan).toBeDefined()
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 0.25),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 0.25)
  )
  try {
    expect(
      nativeFillStrokeTextPixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, a[0])
    ).toBe(false)
  } finally {
    canvas.width = canvas.height = 1
  }
})

it.each([1, 3, 4, 5, 6, 7, Number.NaN])('keeps unproved text rendering mode %s closed', (mode) => {
  const a = anonymousFillStrokeTextFigure().args,
    o = a[5].operators
  o.argsArray[o.fnArray.indexOf(OPS.setTextRenderingMode)][0] = mode
  expect(nativeFillStrokeTextPixelCrop(...a)).toBeUndefined()
})

function paint(): Record<string, unknown> {
  return {
    matrix: [1, 0, 0, -1, 0, 300],
    textMatrix: [1, 0, 0, 1, 60, 210],
    lineWidth: 2,
    lineJoin: 0,
    lineCap: 0,
    miterLimit: 4,
    fillColor: '#000000',
    fillAlpha: 1,
    strokeColor: '#000000',
    strokeAlpha: 1,
    clip: [0, 0, 400, 300]
  }
}

it('charges the complete transformed miter stroke before its native clip', () => {
  expect(nativeFillStrokeGlyphEnvelope([60, 83, 110, 91], paint(), 4)).toEqual([56, 79, 114, 95])
  expect(
    nativeFillStrokeGlyphEnvelope([60, 83, 110, 91], { ...paint(), clip: [58, 80, 112, 93] }, 4)
  ).toEqual([58, 80, 112, 93])
})

it('retains finite rotated and anisotropic text stroke envelopes', () => {
  expect(
    nativeFillStrokeGlyphEnvelope(
      [60, 83, 110, 91],
      { ...paint(), matrix: [0, 2, 3, 0, 0, 0], textMatrix: [0, 2, -2, 0, 0, 0] },
      4
    )
  ).toEqual([54, 79, 116, 95])
})

it('recomputes minimum device stroke protection at the final PNG scale', () => {
  const state = { ...paint(), lineWidth: 0.01, miterLimit: 1, lineJoin: 1 }
  const high = nativeFillStrokeGlyphEnvelope([60, 83, 110, 91], state, 4)
  const low = nativeFillStrokeGlyphEnvelope([60, 83, 110, 91], state, 0.25)
  expect(low[0]).toBeLessThan(high[0])
  expect(low[3]).toBeGreaterThan(high[3])
})

it.each([
  { lineWidth: 0 },
  { lineWidth: -1 },
  { lineWidth: Number.NaN },
  { strokeAlpha: 0.9 },
  { fillAlpha: 0.9 },
  { strokeColor: 'pattern' },
  { lineJoin: 3 },
  { lineCap: 3 },
  { miterLimit: 0 },
  { matrix: [1, 0, 0, 0, 0, 0] },
  { matrix: [1e308, 0, 0, 1e308, 0, 0] },
  { textMatrix: [0, 0, 0, 1, 0, 0] },
  { clip: null }
])('declines an unproved outlined-text state %j', (change) => {
  expect(
    nativeFillStrokeGlyphEnvelope([60, 83, 110, 91], { ...paint(), ...change }, 4)
  ).toBeUndefined()
})
