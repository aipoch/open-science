import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const { recoverOrdinaryThreeLineTables: recover, ordinaryTableCompetitionRect } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-ordinary-three-line.mjs')).href
)

it('retains the full competing region of an existing graphical table', () => {
  const f = ordinaryExample()
  const owner = { region: [0.025, 0.125, 0.975, 0.625] }
  const competition = ordinaryTableCompetitionRect(owner, f.page, 1.5)
  expect(competition).toEqual([10, 20, 390, 100])
  expect(recover(f.page, f.tokens, f.context, [competition])).toEqual([])
})

it('suspends recovery across an existing owner with unknown bounds', () => {
  const f = ordinaryExample()
  const competition = ordinaryTableCompetitionRect({}, f.page, 1.5)
  expect(competition).toEqual([0, 0, f.page.width, f.page.height])
  expect(recover(f.page, f.tokens, f.context, [competition])).toEqual([])
})

it('preserves the existing rendered crop projection at its actual scale', () => {
  const f = ordinaryExample()
  const owner = { cropRect: [400, 200, 600, 250] },
    scale = 2
  const oldProjection = owner.cropRect.map((n) => n / scale)
  const competition = ordinaryTableCompetitionRect(owner, f.page, scale)
  expect(competition).toEqual(oldProjection)
  expect(recover(f.page, f.tokens, f.context, [competition])).toEqual(
    recover(f.page, f.tokens, f.context, [oldProjection])
  )
})
const { ordinaryExample } = await import(
  pathToFileURL(resolve('test/ordinary-three-line-fixture.mjs')).href
)

it('recovers three rows and four columns while preserving whole literal fields', () => {
  const f = ordinaryExample(),
    before = JSON.stringify(f)
  const result = recover(f.page, f.tokens, f.context)
  expect(result).toHaveLength(1)
  expect(result[0].grid).toEqual(f.rows)
  expect(result[0].table.cells).toHaveLength(12)
  expect(
    result[0].table.cells.every(
      (c: ReturnType<typeof JSON.parse>) =>
        c.rowSpan === 1 && c.colSpan === 1 && c.sourceItems.length === 1
    )
  ).toBe(true)
  expect(result[0].table.issues).toEqual([])
  expect(result[0].table.caption).toBeUndefined()
  expect(result[0].table.notes).toEqual([])
  expect(result[0].table.sourceViewport).toEqual({ width: 600, height: 240, scale: 1.5 })
  expect(JSON.stringify(f)).toBe(before)
})

it.each(['grouped', 'merged-header', 'missing-rule', 'foreign-ink'])(
  'preserves an incompatible native %s layout',
  (mode) => {
    const f = ordinaryExample(mode),
      before = JSON.stringify(f)
    expect(recover(f.page, f.tokens, f.context)).toEqual([])
    expect(JSON.stringify(f)).toBe(before)
  }
)

it.each(['ascent', 'descent', 'vertical', 'glyph', 'duplicate', 'overlap', 'caption', 'alpha'])(
  'requires complete native %s evidence',
  (mode) => {
    const f = ordinaryExample()
    if (mode === 'ascent') f.context.content.styles.F.ascent = 0
    if (mode === 'descent') f.context.content.styles.F.descent = NaN
    if (mode === 'vertical') f.context.content.styles.F.vertical = true
    if (mode === 'glyph') f.context.glyphBounds[0].glyphs = []
    if (mode === 'duplicate') f.tokens.push({ ...f.tokens[0] })
    if (mode === 'alpha') {
      f.context.operators.fnArray.unshift(OPS.setGState)
      f.context.operators.argsArray.unshift([[['ca', 0.5]]])
      for (const graphic of f.page.graphicsBounds) graphic.operationIndex++
    }
    const competing = mode === 'overlap' ? [[9, 19, 391, 101]] : []
    const captions = mode === 'caption' ? [{ rect: [20, 25, 90, 35] }] : []
    const before = JSON.stringify(f)
    expect(recover(f.page, f.tokens, f.context, competing, captions)).toEqual([])
    expect(JSON.stringify(f)).toBe(before)
  }
)
