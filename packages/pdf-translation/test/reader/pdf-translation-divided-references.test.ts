import { expect, test } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { dividedNativeReferences } from '../fixtures/divided-native-references.js'

test.each(['one-rule', 'redundant-rules', 'renamed-font-ids'])(
  'keeps a complete native divided bibliography original without changing its ordinary source: %s',
  async (mode) => {
    const fixture = dividedNativeReferences()
    if (mode === 'redundant-rules') {
      fixture.operators.fnArray.push(OPS.constructPath, OPS.constructPath)
      fixture.operators.argsArray.push(
        [OPS.stroke, [new Float32Array([0, 210, 400, 1, 390, 400])]],
        [OPS.stroke, [new Float32Array([0, 240, 400, 1, 360, 400])]]
      )
    }
    if (mode === 'renamed-font-ids') {
      for (const [id, font] of Object.entries(fixture.fonts)) {
        fixture.fonts['arbitrary-' + id] = font
        fixture.styles['arbitrary-' + id] = fixture.styles[id]
        delete fixture.fonts[id]
        delete fixture.styles[id]
      }
      for (const item of fixture.items) item.fontName = 'arbitrary-' + item.fontName
    }
    const result = await extractPdfTranslationSource({
      document: fixture.document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const references = result.source.units.filter((u) =>
      u.fragments.some((f) => f.items.some((i) => i.index >= 3))
    )
    expect(references.length).toBeGreaterThan(8)
    expect(references.every((u) => u.sourceOnly)).toBe(true)
    expect(
      result.source.units.find((u) => u.source.startsWith('The independent'))?.sourceOnly
    ).toBeUndefined()
    expect(result.coverage.warnings.some((w) => w.reasons.includes('ambiguous-line-hyphen'))).toBe(
      true
    )
    expect(result.coverage.excludedItemCount).toBe(0)
    expect(result.source.units.flatMap((u) => u.fragments.flatMap((f) => f.items))).toHaveLength(
      fixture.items.length
    )
  }
)

test.each([
  'ordinary',
  'author-comma',
  'missing-rule',
  'clip',
  'alpha',
  'missing-font',
  'zero-metric',
  'number-gap',
  'font-role-conflict',
  'occluding-fill'
])('refuses an incomplete divided reference proof: %s', async (mode) => {
  const fixture = dividedNativeReferences()
  if (mode === 'ordinary') fixture.items[3].str = '[1] ' + fixture.ordinary
  if (mode === 'author-comma') fixture.items[3].str = '[1] A. Writer, ' + fixture.ordinary
  if (mode === 'missing-rule')
    fixture.operators.fnArray.length = fixture.operators.argsArray.length = 0
  if (mode === 'clip') {
    fixture.operators.fnArray.unshift(OPS.clip)
    fixture.operators.argsArray.unshift([])
  }
  if (mode === 'alpha') {
    fixture.operators.fnArray.unshift(OPS.setGState)
    fixture.operators.argsArray.unshift([[['ca', 0.5]]])
  }
  if (mode === 'missing-font') delete fixture.fonts.Volume
  if (mode === 'zero-metric') {
    fixture.fonts.Body.ascent = 0
    fixture.styles.Body.ascent = 0
  }
  if (mode === 'number-gap')
    fixture.items.find((i) => i.str.startsWith('[5]'))!.str = '[9] A. Writer, Unclosed record.'
  if (mode === 'font-role-conflict')
    for (const item of fixture.items) if (item.fontName === 'Title') item.fontName = 'Volume'
  if (mode === 'occluding-fill') {
    fixture.operators.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
    fixture.operators.argsArray.push(
      ['#ffffff'],
      [OPS.fill, [new Float32Array([0, 180, 399, 1, 420, 399, 1, 420, 401, 1, 180, 401, 4])]]
    )
  }
  const result = await extractPdfTranslationSource({
    document: fixture.document,
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  expect(
    result.source.units.filter((u) => !u.sourceOnly).some((u) => u.source.startsWith('[1]'))
  ).toBe(true)
})
