import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([true, false])(
  'separates raised-contact metadata from an unheaded abstract (matching note=%s)',
  (matching) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      em: number,
      fontName: string,
      hasEOL = true
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height: em,
      hasEOL,
      fontName,
      transform: [em, 0, 0, em, x, y],
      fontAscent: 0.75,
      fontDescent: -0.25,
      fontVertical: false
    })
    const abstract = [
      'The instrument separates calibration signals from the measured background under controlled conditions.',
      'Repeated observations show that minor changes in alignment have limited impact on the result.',
      'All ranges were computed from independently collected samples before averaging the final estimates.',
      'These measurements establish a practical lower uncertainty bound for subsequent experiments.'
    ]
    const items = [
      item(
        'An extended calibration procedure for repeated measurements',
        52,
        732,
        462,
        14,
        'Title'
      ),
      item('under stable laboratory conditions', 52, 714, 306, 14, 'Title', false),
      item('', 88, 700, 0, 0, 'Author'),
      item('Robin M. Reader', 88, 700, 65, 9.5, 'Author', false),
      item('', 88, 689.5, 0, 0, 'Affiliation'),
      item(
        'Institute for Instrumentation and Applied Measurements, Example Campus,',
        88,
        689.5,
        436,
        9,
        'Affiliation'
      ),
      item('505010, Exampleland', 88, 679, 74, 9, 'Affiliation', false),
      item('b)', 162, 682.2, 5.4, 7, 'Text', false),
      item('', 88, 662.2, 0, 0, 'Text'),
      ...abstract.map((line, n) => item(line, 88, 662.2 - n * 11.5, 468, 10, 'Text')),
      item('The initial calibration was completed on a stable', 63, 596, 235, 10, 'Text'),
      item('work surface under fixed measurement conditions.', 53, 584.5, 245, 10, 'Text'),
      item(`${matching ? 'b' : 'c'})Electronic mail: reader@example.test`, 53, 72, 163, 9, 'Text')
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const metadata = units.find((u) => u.source.startsWith('Robin M. Reader'))
    expect(metadata).toBeDefined()
    if (matching) {
      expect(metadata).toMatchObject({ sourceOnly: true })
      expect(metadata?.source).not.toContain(abstract[0])
      const body = units.find((u) => u.source.startsWith(abstract[0]))
      expect(body?.source).toBe(abstract.join(' '))
      expect(body?.sourceOnly).toBeUndefined()
      expect(body?.items).toHaveLength(4)
      expect(metadata?.items).toHaveLength(4)
    } else {
      expect(metadata?.sourceOnly).toBeUndefined()
      expect(metadata?.source).toContain(abstract[0])
    }
  }
)
