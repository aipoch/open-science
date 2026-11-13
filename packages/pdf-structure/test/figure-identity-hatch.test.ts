import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { createCanvas } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { anonymousIdentityHatchFigure } = await import(
  pathToFileURL(resolve('test/fixtures/identity-hatch-figure.mjs')).href
)
const hatch = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-categorical-hatch.mjs')).href
).catch(() => ({}))
const packets = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
it('completes a whole independent identity-hatch program without granting Source', () => {
  const f = anonymousIdentityHatchFigure(true),
    a = f.args,
    before = JSON.stringify(a)
  const plan = hatch.nativeCategoricalHatchPixelCrop?.(...a, f.peers, a[1].rect)
  expect(plan).toBeDefined()
  expect(plan.rect[3]).toBeGreaterThan(185)
  expect(plan.sourceItems).toBeUndefined()
  expect(JSON.stringify(a)).toBe(before)
})

it('keeps identity-hatch evidence separate from default and rotated-hatch observers', () => {
  const f = anonymousIdentityHatchFigure(),
    a = f.args,
    handle = packets.createNativeIdentityHatchPixelEvidence(a[0], a[4], a[5])
  expect(packets.nativeIdentityHatchPixelEvidenceData(handle, a[0], a[4], a[5])).toBeDefined()
  expect(packets.nativeSavedUncoloredPixelEvidenceData(handle, a[0], a[4], a[5])).toBeUndefined()
  expect(packets.createNativeSavedUncoloredPixelEvidence(a[0], a[4], a[5])).toBeUndefined()
  expect(
    packets.nativeClosedProgramInkPacket(a[0], a[4], a[5], [a[4][0].sourceItem])
  ).toBeUndefined()
})

it('binds both complete programs and withdraws changed original paint descriptors', () => {
  const f = anonymousIdentityHatchFigure(true),
    a = f.args,
    plan = hatch.nativeCategoricalHatchPixelCrop(...a, f.peers, a[1].rect),
    canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 3),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 3)
    )
  const png = canvas.toBuffer('image/png')
  expect(hatch.nativeCategoricalHatchPixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
  expect(
    hatch.nativeCategoricalHatchPixelPngSafe(structuredClone(plan), png, plan.rect, a[0])
  ).toBe(false)
  const at = a[5].operators.fnArray.indexOf(OPS.setFillColorN)
  a[5].operators.argsArray[at][2].argsArray[1][0] *= 2
  expect(hatch.nativeCategoricalHatchPixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
  canvas.width = canvas.height = 1
})

it('requires the actual final PNG to meet the proven minimum raster scale', () => {
  const f = anonymousIdentityHatchFigure(),
    a = f.args,
    plan = hatch.nativeCategoricalHatchPixelCrop(...a, f.peers, a[1].rect),
    canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 0.5),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 0.5)
    )
  expect(
    hatch.nativeCategoricalHatchPixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, a[0])
  ).toBe(false)
  canvas.width = canvas.height = 1
})

it.each([
  'alpha',
  'blend',
  'matrix',
  'tile-clip',
  'step',
  'tile-program',
  'caption',
  'foreign-caption',
  'table',
  'split-owner',
  'source-literal',
  'open-save',
  'neighbor-text'
])('declines an incomplete or foreign identity-hatch program: %s', (change) => {
  const f = anonymousIdentityHatchFigure(true),
    a = f.args,
    o = a[5].operators,
    pattern = o.argsArray[o.fnArray.indexOf(OPS.setFillColorN)]
  if (change === 'alpha')
    o.argsArray[0] = [
      [
        ['CA', 1],
        ['ca', 0.9]
      ]
    ]
  if (change === 'blend') o.argsArray[0] = [[['BM', 'source-over']]]
  if (change === 'matrix') pattern[3][2] = 0.1
  if (change === 'tile-clip') pattern[4][0] = 0
  if (change === 'step') pattern[6] *= 2
  if (change === 'tile-program') pattern[2].fnArray[1] = OPS.setFont
  if (change === 'caption') a[1].caption.lines[0] = 'Figure 1. Different caption.'
  if (change === 'foreign-caption')
    a[2].push({ page: 1, lines: ['Figure 3. Other.'], rect: [60, 175, 200, 190] })
  if (change === 'table') a[3].push([60, 175, 200, 190])
  if (change === 'split-owner') a[1].sourceItems = [a[4][0].sourceItem]
  if (change === 'source-literal') a[5].content.items[0].str = 'Changed source.'
  if (change === 'open-save') o.fnArray[o.fnArray.indexOf(OPS.restore)] = OPS.dependency
  if (change === 'neighbor-text') {
    const shows = o.fnArray.flatMap((op, i) =>
        op === OPS.showText && o.argsArray[i][0][0].unicode === 'First block' ? [i] : []
      ),
      at = shows[1]
    o.argsArray[at - 1][0][4] = 60
    o.argsArray[at - 1][0][5] = 115
    const r = a[5].content.items[4]
    r.transform[4] = 60
    r.transform[5] = 115
    a[4] = a[5].content.items.map((r) => tableTextToken(r, a[5].viewport, 0))
  }
  expect(hatch.nativeCategoricalHatchPixelCrop(...a, f.peers, a[1].rect)).toBeUndefined()
})
