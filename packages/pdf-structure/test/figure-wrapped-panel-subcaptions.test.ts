import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas } from '@napi-rs/canvas'
const { anonymousWrappedPanelSubcaptions } = await import(
  pathToFileURL(resolve('test/fixtures/wrapped-panel-subcaptions.mjs')).href
)
const { nativeCompleteFormCrop, nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)
const prove = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> => {
  const a = f.args
  return nativeCompleteFormCrop(a[0], f.figure, a[1], a[2], a[5], a[6])
}
it('does not continue a complete subcaption into the next independent paragraph', () => {
  expect(prove(anonymousWrappedPanelSubcaptions({ extraTailParagraph: true }))).toBeUndefined()
})
it('retains a hyphenated wrapped continuation without rewriting source text', () => {
  const f = anonymousWrappedPanelSubcaptions({ mode: 'vector', hyphenContinuation: true })
  const before = JSON.stringify(f)
  expect(prove(f)?.rect[3]).toBeCloseTo(f.expectedBottom, 8)
  expect(JSON.stringify(f)).toBe(before)
})
it('refuses duplicate markers and incomplete caption binding', () => {
  expect(prove(anonymousWrappedPanelSubcaptions({ duplicateMarker: true }))).toBeUndefined()
  const f = anonymousWrappedPanelSubcaptions()
  f.figure.caption.lines[0] = 'Figure 1. Several'
  expect(prove(f)).toBeUndefined()
})
it.each(['raster', 'vector'])(
  'retains every wrapped native subcaption line below %s panels',
  (mode) => {
    for (const options of [{ mode }, { mode, scale: 1.5, dx: 13 }]) {
      const f = anonymousWrappedPanelSubcaptions(options),
        before = JSON.stringify(f)
      const result = prove(f)
      expect(result).toBeDefined()
      expect(result.rect[3]).toBeCloseTo(f.expectedBottom, 8)
      expect(result.sourceItems).toBeUndefined()
      expect(JSON.stringify(f)).toBe(before)
    }
  }
)
it.each(['raster', 'vector'])(
  'excludes foreign paint and broken native programs from %s completion',
  (mode) => {
    for (const kind of ['white text', 'foreign paint', 'incomplete advance', 'invalid viewport']) {
      const f = anonymousWrappedPanelSubcaptions({ mode }),
        a = f.args,
        o = a[6].operators
      if (kind === 'white text') o.argsArray[0] = ['#ffffff']
      if (kind === 'incomplete advance')
        a[6].content.items.find((r: { str: string }) => r.str.startsWith('(a)')).width += 2
      if (kind === 'invalid viewport') a[6].viewport.scale = 2
      if (kind === 'foreign paint') {
        o.fnArray.push(OPS.constructPath)
        o.argsArray.push([OPS.fill, [[0, 80, 95, 1, 90, 95, 1, 90, 105, 4]], [80, 95, 90, 105]])
      }
      expect(prove(f), kind).toBeUndefined()
    }
  }
)
it('keeps foreign micro-sign source normalization outside this contract', async () => {
  const f = anonymousWrappedPanelSubcaptions(),
    a = f.args
  f.text('µ', 350, 430)
  const r = a[6].content.items.at(-1)
  r.str = 'μ'
  r.sourceItem.text = 'μ'
  const { tableTextToken } = await import(
    pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
  )
  a[5][a[5].length - 1] = tableTextToken(r, a[6].viewport, 0)
  expect(prove(f)).toBeUndefined()
})
it.each(['raster', 'vector'])('checks actual PNG bounds after %s paragraph completion', (mode) => {
  const f = anonymousWrappedPanelSubcaptions({ mode }),
    result = prove(f),
    page = f.args[0]
  const rect = result.rect.map((v: number, i: number) => v + (i < 2 ? -2 : 2))
  const canvas = createCanvas(
    Math.ceil((rect[2] - rect[0]) * 3),
    Math.ceil((rect[3] - rect[1]) * 3)
  )
  try {
    expect(nativeCompleteFormCropPngSafe(canvas.toBuffer('image/png'), rect, page, result)).toBe(
      true
    )
    canvas.width = 2
    canvas.height = 3
    expect(nativeCompleteFormCropPngSafe(canvas.toBuffer('image/png'), rect, page, result)).toBe(
      false
    )
  } finally {
    canvas.width = canvas.height = 1
  }
})
it.each(['font metrics', 'font glyphs', 'source carrier', 'foreign paragraph', 'table', 'caption'])(
  'refuses incomplete wrapped-label ownership: %s',
  (kind) => {
    const f = anonymousWrappedPanelSubcaptions(),
      a = f.args
    if (kind === 'font metrics') delete a[6].content.styles.F.ascent
    if (kind === 'font glyphs') a[6].glyphBounds = []
    if (kind === 'source carrier') delete a[6].content.items[0].sourceItem
    if (kind === 'foreign paragraph') f.text('Independent paragraph.', 75, 365)
    if (kind === 'table') a[2].push([80, 360, 130, 370])
    if (kind === 'caption')
      a[1].push({ page: 1, lines: ['Figure 2. Other.'], rect: [80, 360, 130, 370] })
    expect(prove(f)).toBeUndefined()
  }
)
