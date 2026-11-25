import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

function run(
  str: string,
  x: number,
  y: number,
  width: number,
  { size = 10, hasEOL = true, fontName = 'body' } = {}
): PdfLayoutTextItem {
  return {
    str,
    dir: 'ltr',
    width,
    height: size,
    transform: [size, 0, 0, size, x, y],
    hasEOL,
    fontName,
    fontVertical: false
  }
}

function layout(
  previous: PdfLayoutTextItem[],
  next: PdfLayoutTextItem[]
): ReturnType<typeof groupPdfTranslationPages> {
  return groupPdfTranslationPages({
    pages: [previous, next].map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
  })
}

it.each([true, false])(
  'joins an explicitly broken word below an opening figure and scored table when columns agree (%s)',
  (aligned) => {
    const previous = [
      run('Earlier studies systematically measured the levels at the last station.', 50, 490, 240),
      run('The station normally registers a mean level close to the constant', 310, 97, 240),
      run('value obtained by the companion method. In this survey,', 310, 85, 240),
      run('we systemati-', 480, 73, 70),
      run('1', 297.5, 44, 5, { hasEOL: false })
    ]
    const x = aligned ? 50 : 56
    const next = [
      run('Fig. 1: Timelines for the repeated measurements at each station.', 50, 565, 500),
      run('The marker specifies the common reference period.', 90, 553, 416),
      run('Table I: Counts for all three intervals in the station survey.', 50, 519, 240),
      ...['Interval', 'North', 'South', 'West'].map((text, col) =>
        run(text, 50 + col * 60, 497, col ? 25 : 48, { size: 9, hasEOL: col === 3 })
      ),
      ...['Winter', 'Summer', 'Autumn'].flatMap((name, row) =>
        [name, '3', '4', '5'].map((text, col) =>
          run(text, 50 + col * 60, 486 - row * 11, col ? 5 : 35, {
            size: 9,
            hasEOL: col === 3
          })
        )
      ),
      run('cally remove outlying records from the master inventory to retain', x, 415, 240),
      run('a stable set of samples for the weekly measurements described in', x, 403, 240),
      run('the remaining sections of the report.', x, 391, 155)
    ]
    const { units } = layout(previous, next)
    const owner = units.find((unit) => unit.items.includes('1:3'))!
    expect(owner.source.includes('systematically remove outlying records')).toBe(aligned)
    expect(owner.fragments.map(({ page }) => page)).toEqual(aligned ? [1, 2] : [1])
    expect(units.find((unit) => unit.source === '1')?.preserve).toBe('literal')
    expect(units.flatMap(({ items }) => items).sort()).toEqual(
      [...previous.map((_, i) => '1:' + i), ...next.map((_, i) => '2:' + i)].sort()
    )
  }
)

it.each([true, false])(
  'reconstitutes one terminal row before joining below a figure caption (matching font %s)',
  (aligned) => {
    const preceding = [
      run('The latest sample is numbered according to its production period.', 310, 165, 240),
      run('The uniform pattern helps determine where the junctions form.', 310, 153, 240),
      run('A reference on the left marks the origin for the whole surface.', 310, 141, 240),
      run('The other markers indicate prior observations along the rail.', 310, 129, 240),
      run('The remaining data are stored with the corresponding frame.', 310, 117, 240, {
        hasEOL: false
      })
    ]
    const closing = [
      ['Although', 33],
      ['the', 13],
      ['pattern', 27],
      ['is', 7],
      ['uniform', 30],
      ['and', 15],
      ['stable,', 22],
      ['the', 12]
    ] as const
    // Each word comes from a separate PDF text show with a large justification gap.
    let x = 310
    const previous = [
      ...preceding,
      ...closing.map(([word, width], index) => {
        const item = run(word, x, 105, width, {
          hasEOL: false,
          fontName: !aligned && index === 4 ? 'other' : 'body'
        })
        x += width + 81 / 7
        return item
      })
    ]
    const next = [
      run('Fig. 1. Two views of the scale used for the', 50, 615, 151, {
        size: 9,
        hasEOL: false
      }),
      run('sample inventory.', 50, 605, 70, { size: 9, hasEOL: false }),
      run('first measurement varies with the shift in the indicator over time.', 50, 588, 240, {
        hasEOL: false
      }),
      run('We trace this shift through several repeat runs made at different', 50, 576, 240, {
        hasEOL: false
      }),
      run('intervals defined by the common calibration.', 50, 564, 169, { hasEOL: false })
    ]
    const { units, pages } = layout(previous, next)
    const owner = units.find((unit) => unit.items.includes('1:5'))!
    expect(
      owner.source.includes('Although the pattern is uniform and stable, the first measurement')
    ).toBe(aligned)
    expect(owner.fragments.map(({ page }) => page)).toEqual(aligned ? [1, 2] : [1])
    if (aligned) {
      const row = pages[0].blocks.find(({ id }) => id === owner.fragments[0].id)
      expect(row?.items).toHaveLength(closing.length)
      expect(row?.lines).toHaveLength(1)
      expect(row?.rect.right).toBeCloseTo(550)
    }
    expect(units.flatMap(({ items }) => items).sort()).toEqual(
      [...previous.map((_, i) => '1:' + i), ...next.map((_, i) => '2:' + i)].sort()
    )
  }
)
