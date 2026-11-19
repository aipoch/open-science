import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

function captionBesideProse(tailFont: string): PdfLayoutPage {
  const items: PdfLayoutPage['items'] = []
  const add = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Body',
    hasEOL = true,
    size = 9
  ): void => {
    items.push({
      str,
      width,
      height: size,
      dir: 'ltr',
      hasEOL,
      transform: [size, 0, 0, size, x, y],
      fontName,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false
    })
  }
  add('The initial setting was selected from a separate survey', 58, 342, 227)
  add('to compare several independent methods for calibration.', 58, 330, 227)
  add('Each approach uses the same observations for training.', 58, 319, 227)
  add('The selected parameters remain consistent during testing.', 58, 309, 227)
  add('These procedures serve as the basis for the comparison.', 58, 298, 227)
  for (const y of [289.5, 279.5, 270, 261, 251])
    add('The remaining observations describe a separate condition.', 58, y, 227)

  add('Table 1:', 313, 329, 28, 'Body', false)
  add('Experimental scores across the validation groups. Best', 344, 329, 195, 'Caption')
  add(
    'estimates are shown in bold, and runner-up values are marked.',
    313,
    318.6,
    224,
    tailFont,
    false
  )
  const columns = [321, 401, 446, 483, 513]
  const rows = [
    ['Method', 'Score', 'Mean', 'Recall', 'Value'],
    ['Model A', '0.287', '0.549', '0.338', '0.439'],
    ['Model B', '0.307', '0.756', '0.548', '0.578'],
    ['Model C', '0.472', '0.634', '0.677', '0.690']
  ]
  for (const [row, values] of rows.entries())
    for (const [column, value] of values.entries())
      add(
        value,
        columns[column],
        299 - row * 9.4,
        column ? 19 : 40,
        row ? 'Body' : 'Header',
        column === 4,
        8
      )

  return { page: 1, width: 595, height: 842, rotation: 0, items }
}

it.each(['Caption', 'Other'])(
  'joins the table caption only with its native continuation font: %s',
  (tailFont) => {
    const page = captionBesideProse(tailFont)
    const { units } = groupPdfTranslationPages({ pages: [page] })
    const byItem = (index: number): (typeof units)[number] =>
      units.find((unit) => unit.items.includes('1:' + index))!
    const caption = byItem(10)
    expect(caption.items).toEqual(
      tailFont === 'Caption' ? ['1:10', '1:11', '1:12'] : ['1:10', '1:11']
    )
    expect(caption.source.endsWith('runner-up values are marked.')).toBe(tailFont === 'Caption')
    expect(byItem(13).items).toEqual(['1:13'])
    expect(byItem(19).source).toBe('0.287')
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      page.items.map((_, index) => '1:' + index).sort()
    )
  }
)
