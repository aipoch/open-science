import { expect, test } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

function run(
  str: string,
  fontName: string,
  x: number,
  baseline: number,
  width: number,
  hasEOL = false
): PdfLayoutTextItem {
  const scale = 11
  return {
    str,
    dir: 'ltr',
    transform: [scale, 0, 0, scale, x, baseline],
    width,
    height: str ? scale : 0,
    fontName,
    fontAscent: 0.694,
    fontDescent: -0.194,
    fontVertical: false,
    hasEOL
  }
}

test.each([true, false])(
  'separates a same-size title and byline above a styled abstract (%s)',
  (styled) => {
    const title = run('Observing Seasonal Changes in Coastal Winds', 'head', 189, 757, 230)
    const byline = run('Mara L. COLE and Jules RIVERA', 'author', 193, 738.4, 225)
    const label = run('Abstract:', styled ? 'head' : 'body', 70, 696, 51)
    const body = run(
      'This study follows a network of field stations through four seasons and compares the records.',
      'body',
      125,
      696,
      410,
      true
    )
    const items = [
      title,
      run('', 'author', 193, 738.4, 0, true),
      byline,
      run('', label.fontName!, 70, 696, 0, true),
      label,
      body,
      run(
        'The measurements show that two stations give consistent results.',
        'body',
        70,
        681,
        345,
        true
      )
    ]
    const result = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const heading = result.units.find((unit) => unit.items.includes('1:0'))
    const authors = result.units.find((unit) => unit.items.includes('1:2'))
    expect(heading?.sourceOnly).not.toBe(true)
    if (styled) {
      expect(heading?.source).toBe(title.str)
      expect(authors).toMatchObject({ source: byline.str, sourceOnly: true })
    } else {
      expect(authors).toBe(heading)
    }
  }
)
