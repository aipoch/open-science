import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousClosedSaveFigure, addAnonymousUnclaimedFigureGlyph } = await import(
  pathToFileURL(resolve('test/fixtures/closed-save-figure.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { anonymousPairedProgramFigure } = await import(
  pathToFileURL(resolve('test/fixtures/closed-program-figure.mjs')).href
)
const { nativeClosedProgramFigureCrop, nativeClosedProgramPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-closed-program.mjs')).href
)
const { nativeClosedSaveFigureCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-closed-save.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas } from '@napi-rs/canvas'

it('owns two complete native panels and their exterior whole subcaptions', () => {
  const f = anonymousPairedProgramFigure(),
    [page, , captions, tables, tokens, context] = f.args,
    before = JSON.stringify(f),
    result = associateFigures(page, captions, tables, [], [], tokens, context)
  expect(result[0]?.sourceItems).toEqual(
    context.content.items.slice(0, 8).map((r: { sourceItem: unknown }) => r.sourceItem)
  )
  expect(result[0]?.graphicsCount).toBe(6)
  expect(JSON.stringify(f)).toBe(before)
})

it('retains a complete isolated ordinary drawing through public association', () => {
  const f = anonymousClosedSaveFigure('isolated-group'),
    [page, , captions, tables, tokens, context] = f.args,
    result = associateFigures(page, captions, tables, [], [], tokens, context)
  expect(result[0]?.sourceItems).toHaveLength(3)
})

it('retains complete owners while preserving foreign zero-metric glyph envelopes', () => {
  const f = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure(), {
      text: '•',
      x: 330
    }),
    [page, , captions, tables, tokens, context] = f.args
  context.content.styles.Unclaimed = { ascent: 0, descent: 0, vertical: false }
  const before = JSON.stringify(f),
    result = associateFigures(page, captions, tables, [], [], tokens, context)
  expect(result[0]?.sourceItems).toHaveLength(3)
  expect(result[0]?.formCropRaster.foreignPaints).toContainEqual({
    rect: [330, 170, 335, 181],
    floor: 0
  })
  expect(JSON.stringify(f)).toBe(before)
})

it.each([
  'knockout',
  'translucent',
  'matrix',
  'curve',
  'bbox',
  'width',
  'missing-font',
  'table',
  'open-form'
])('refuses an incomplete paired native program: %s', (fault) => {
  const f = anonymousPairedProgramFigure(),
    a = f.args,
    context = a[5],
    o = context.operators
  if (fault === 'knockout') o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0].knockout = true
  if (fault === 'translucent') {
    const i = o.fnArray.indexOf(OPS.beginGroup)
    o.fnArray.splice(i, 0, OPS.setGState)
    o.argsArray.splice(i, 0, [[['ca', 0.5]]])
  }
  if (fault === 'matrix')
    o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0].matrix = [1, 0, 0, 1, 0, 0]
  const stroke = o.fnArray.findIndex(
    (op: number, i: number) => op === OPS.constructPath && o.argsArray[i][0] === OPS.stroke
  )
  if (fault === 'curve') o.argsArray[stroke][1][0][3] = 2
  if (fault === 'bbox') o.argsArray[stroke][2][0] += 1
  if (fault === 'width') context.content.items[0].width += 1
  if (fault === 'missing-font') context.glyphBounds = []
  if (fault === 'table') a[3].push([50, 100, 100, 150])
  if (fault === 'open-form') o.fnArray[o.fnArray.indexOf(OPS.paintFormXObjectEnd)] = OPS.dependency
  expect(nativeClosedProgramFigureCrop(...a)).toBeUndefined()
})

it.each([{ rightLabel: 'Ordinary paragraph' }, { labelOffset: 2 }])(
  'requires two independently aligned whole subcaptions: %j',
  (options) => {
    expect(
      nativeClosedProgramFigureCrop(...anonymousPairedProgramFigure(options).args)
    ).toBeUndefined()
  }
)

it.each([' ', '', '\t', '\u00a0'])(
  'retains and rejects an unowned painted glyph inside a complete program: %j',
  (text) => {
    const f = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure('isolated-group'), {
      text,
      insideScope: true
    })
    expect(nativeClosedProgramFigureCrop(...f.args)).toBeUndefined()
  }
)

it('keeps the old default group and font-metrics guards unchanged', () => {
  const f = anonymousClosedSaveFigure('isolated-group')
  expect(nativeClosedSaveFigureCrop(...f.args)).toBeUndefined()
  expect(nativeClosedProgramFigureCrop(...f.args)?.sourceItems).toHaveLength(3)
})

it('retains the independent caption when it shares a BT with the subcaption', () => {
  const f = anonymousPairedProgramFigure(),
    o = f.args[5].operators,
    shows = o.fnArray.flatMap((op: number, i: number) => (op === OPS.showText ? [i] : [])),
    at = shows[7] + 1
  expect(o.fnArray.slice(at, at + 2)).toEqual([OPS.endText, OPS.beginText])
  o.fnArray.splice(at, 2)
  o.argsArray.splice(at, 2)
  const result = nativeClosedProgramFigureCrop(...f.args)
  expect(result?.sourceItems).toHaveLength(8)
  expect(result?.sourceItems.some((s: { index: number }) => s.index === 8)).toBe(false)
})

it('rejects two whole records sharing one physical glyph', () => {
  const f = anonymousPairedProgramFigure(),
    a = f.args,
    c = a[5],
    o = c.operators,
    shows = o.fnArray.flatMap((op: number, i: number) => (op === OPS.showText ? [i] : [])),
    first = c.content.items[0],
    second = c.content.items[1],
    glyph = o.argsArray[shows[0]][0][0]
  glyph.unicode = 'AB'
  glyph.fontChar = '!'
  c.glyphBounds[0].glyphs.push({ fontChar: '!', bounds: [0, -0.1, 2, 0.7] })
  o.argsArray[shows[1]] = [[]]
  for (const [i, raw] of [first, second].entries()) {
    raw.str = raw.sourceItem.text = i ? 'B' : 'A'
    raw.width = first.width
    raw.transform = [...first.transform]
    a[4][i] = tableTextToken(raw, c.viewport, 0)
  }
  expect(nativeClosedProgramFigureCrop(...a)).toBeUndefined()
})

it('requires complete advances for foreign zero-metric sources', () => {
  const f = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure(), { text: '•', x: 330 }),
    c = f.args[5]
  c.content.styles.Unclaimed = { ascent: 0, descent: 0, vertical: false }
  c.content.items.at(-1).width += 1
  expect(nativeClosedProgramFigureCrop(...f.args)).toBeUndefined()
})

it('bounds native program search before partitioning every scope', () => {
  const f = anonymousPairedProgramFigure(),
    o = f.args[5].operators
  for (let i = 0; i < 513; i++) {
    o.fnArray.push(OPS.save, OPS.restore)
    o.argsArray.push(null, null)
  }
  expect(nativeClosedProgramFigureCrop(...f.args)).toBeUndefined()
})

it('rejects extreme anisotropy even when both axis scales are near zero', () => {
  const f = anonymousPairedProgramFigure({ anisotropicStroke: true })
  expect(nativeClosedProgramFigureCrop(...f.args)).toBeUndefined()
})

it.each(['native', 'owners', 'proof', 'clone', 'token-text', 'token-rect', 'invalid-page'])(
  'binds final PNG validation to its exact proposal and native context: %s',
  (fault) => {
    const f = anonymousPairedProgramFigure(),
      a = f.args,
      candidate = nativeClosedProgramFigureCrop(...a),
      rect = candidate.rect.map((v: number, i: number) => v + (i < 2 ? -2 : 2)),
      canvas = createCanvas(Math.ceil((rect[2] - rect[0]) * 4), Math.ceil((rect[3] - rect[1]) * 4))
    try {
      const png = canvas.toBuffer('image/png')
      expect(nativeClosedProgramPngSafe(png, rect, a[0], candidate)).toBe(true)
      if (fault === 'native') a[5].content.items[0].str += 'changed'
      if (fault === 'token-text') a[4][0].text += 'changed'
      if (fault === 'token-rect') a[4][0].rect[0] += 1
      if (fault === 'invalid-page') a[0].invalidGraphicsBounds = 1
      if (fault === 'owners') candidate.sourceItems = candidate.sourceItems.slice(1)
      if (fault === 'proof') candidate.formCropRaster.foreignPaints = []
      const actual = fault === 'clone' ? structuredClone(candidate) : candidate
      expect(nativeClosedProgramPngSafe(png, rect, a[0], actual)).toBe(false)
    } finally {
      canvas.width = canvas.height = 1
    }
  }
)

it.each(['page-number', 'rotation', 'same-dimensions-other-page', 'mutated-page'])(
  'binds PNG verification to its exact page instance and geometry: %s',
  (fault) => {
    const f = anonymousPairedProgramFigure(),
      a = f.args,
      candidate = nativeClosedProgramFigureCrop(...a),
      rect = candidate.rect.map((v: number, i: number) => v + (i < 2 ? -2 : 2)),
      canvas = createCanvas(Math.ceil((rect[2] - rect[0]) * 4), Math.ceil((rect[3] - rect[1]) * 4))
    try {
      const png = canvas.toBuffer('image/png')
      expect(nativeClosedProgramPngSafe(png, rect, a[0], candidate)).toBe(true)
      let page = { ...a[0] }
      if (fault === 'page-number') page.pageNumber++
      if (fault === 'rotation') page.rotation = 90
      if (fault === 'mutated-page') {
        page = a[0]
        page.rotation = 90
      }
      expect(nativeClosedProgramPngSafe(png, rect, page, candidate)).toBe(false)
    } finally {
      canvas.width = canvas.height = 1
    }
  }
)
