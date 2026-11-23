import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([
  { text: 'тельство общего утверждения [A] (см. ниже), а также объясняется', prose: true },
  { text: 'пределы и формулы α + β = π', prose: false },
  { text: 'пределы и формулы ∑(x)', prose: false },
  { text: 'Круг. Известны результаты [A]. Классическо-', prose: false },
  { text: 'и WX соответственно. Они пересекаются (см. ниже).', prose: false }
])('classifies a Cyrillic continuation with native math guards: $text', ({ text, prose }) => {
  const row = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Body'
  ): PdfLayoutTextItem => ({
    str,
    dir: 'ltr',
    width,
    height: 12,
    transform: [12, 0, 0, 12, x, y],
    fontName,
    fontAscent: 0.72,
    fontDescent: -0.18,
    fontVertical: false,
    hasEOL: true
  })
  const items = [
    row('В этой заметке изложен новый способ вычисления и простое доказа-', 84, 734, 440),
    row(text, 72, 720, 452),
    row('его связь с задачей о длине замкнутой границы.', 72, 706, 270),
    row('∠X = ∠Y + ∠Z.', 237, 668, 112, 'Math')
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
  })
  const continuation = units.find((unit) => unit.items.includes('1:1'))
  if (prose) {
    expect(continuation?.items).toEqual(['1:0', '1:1', '1:2'])
    expect(continuation?.sourceOnly).toBeUndefined()
  } else {
    expect(continuation).toMatchObject({ preserve: 'formula', sourceOnly: true, items: ['1:1'] })
  }
  expect(units.find((unit) => unit.items.includes('1:3'))).toMatchObject({
    preserve: 'formula',
    sourceOnly: true
  })
  expect(units.flatMap((unit) => unit.originalStrings)).toEqual(items.map(({ str }) => str))
})
