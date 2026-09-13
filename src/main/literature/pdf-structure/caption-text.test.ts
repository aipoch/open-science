import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const {
  captionKind,
  joinCaptionLines,
  groupPageLines,
  joinPdfSmallCapsLine,
  findCaptionCandidates
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)

it('removes synthetic near-zero spaces between a full capital and small caps', () => {
  const items = [
    { str: 'T', height: 8, width: 4.888, fontName: 'Times', transform: [8, 0, 0, 8, 10, 100] },
    { str: ' ', height: 0, width: 0.0007, fontName: 'Times', transform: [6, 0, 0, 6, 14.888, 100] },
    {
      str: 'ABLE',
      height: 6,
      width: 15,
      fontName: 'Times',
      transform: [6, 0, 0, 6, 14.892, 99.9996]
    },
    { str: ' 1. A ', height: 8, width: 20, fontName: 'Times', transform: [8, 0, 0, 8, 32, 100] },
    { str: 'VALUE', height: 6, width: 20, fontName: 'Times', transform: [6, 0, 0, 6, 53, 100] }
  ]
  expect(joinPdfSmallCapsLine(items)).toBe('TABLE 1. A VALUE')
  expect(items[1].str).toBe(' ')
  for (const after of [
    { ...items[2], transform: [6, 0, 0, 6, 17, 100] },
    { ...items[2], transform: [6, 0, 0, 6, 14.892, 102] },
    { ...items[2], transform: [0, 6, -6, 0, 14.892, 100] },
    { ...items[2], height: 8 },
    { ...items[2], fontName: 'Other' },
    { ...items[2], str: 'able' }
  ])
    expect(joinPdfSmallCapsLine([items[0], items[1], after])).toBe('T ' + after.str)
})

it.each([
  [4.664, 594.3319, 143.2375, '²³'],
  [6.4, 595.1399, 143.2375, ' 23'],
  [8, 593.5399, 143.2375, ' 23'],
  [4.664, 594.3319, 148, ' 23']
])(
  'distinguishes raised numeric references from ordinary smaller numbers (%s, %s, %s)',
  (fontSize, y, x, expected) => {
    const lines = [
      {
        text: 'American Pathologists.',
        x: 67.815,
        y: 593.5399,
        width: 75.319,
        height: 8,
        fontSize: 8
      },
      { text: '23', x, y, width: 4.617, height: fontSize, fontSize },
      {
        text: 'According to these guidelines.',
        x: x + 6.6906,
        y: 593.6599,
        width: 110,
        height: 8,
        fontSize: 8
      }
    ]
    expect(groupPageLines({ lines })[0].text).toBe(
      `American Pathologists.${expected} According to these guidelines.`
    )
    expect(lines[1].text).toBe('23')
  }
)

it('reflows physical caption lines without losing content or inventing word breaks', () => {
  expect(
    joinCaptionLines([
      'Figure 1. Change from baseline.',
      'Patients who had',
      'both assessments were included.'
    ])
  ).toBe('Figure 1. Change from baseline. Patients who had both assessments were included.')
  expect(joinCaptionLines(['target-', 'lesion assess\u00ad', 'ments'])).toBe(
    'target-lesion assessments'
  )
})

it('reflows only line-end hyphens supported by an unbroken spelling on the source page', () => {
  const lines = ['No significant dif-', 'ferences between groups.']
  expect(joinCaptionLines(lines, new Set(['differences']))).toBe(
    'No significant differences between groups.'
  )
  expect(lines).toEqual(['No significant dif-', 'ferences between groups.'])
  for (const words of [undefined, new Set(), new Set(['differences', 'dif-ferences'])]) {
    expect(joinCaptionLines(lines, words)).toBe('No significant dif-ferences between groups.')
  }
  expect(joinCaptionLines(['Signif-', 'icant difference.'], new Set(['significant']))).toBe(
    'Significant difference.'
  )
  expect(joinCaptionLines(['target-', 'lesion assessments'], new Set(['target-lesion']))).toBe(
    'target-lesion assessments'
  )
  expect(joinCaptionLines(['Already hyphen-ated within one line.'], new Set(['hyphenated']))).toBe(
    'Already hyphen-ated within one line.'
  )
  expect(joinCaptionLines(['Group A-', 'B'], new Set(['ab']))).toBe('Group A-B')
})

it('preserves a real hyphen while removing the synthetic spaces around small caps', () => {
  const part = (str: string, x: number, width: number, height: number): object => ({
    str,
    width,
    height,
    fontName: 'Times',
    transform: [height || 8, 0, 0, height || 8, x, 100]
  })
  const items = [
    part('BASE', 0, 15, 6),
    part(' ', 15, 0.003, 0),
    part('-L', 15.027, 8, 8),
    part(' ', 23.027, 0.001, 0),
    part('INE', 23.033, 11, 6),
    part(' ', 34.033, 0.003, 0),
    part('.*', 34.055, 6, 8)
  ]
  expect(joinPdfSmallCapsLine(items)).toBe('BASE-LINE.*')
  expect(
    joinPdfSmallCapsLine([
      part('10 P', 0, 16, 8),
      part(' ', 16, 0.001, 0),
      part('ERCENT', 16.01, 25, 6)
    ])
  ).toBe('10 PERCENT')
  expect(
    joinPdfSmallCapsLine([
      part('INTENTION', 0, 30, 6),
      part(' ', 30, 0.01, 0),
      part('-', 30.08, 3, 8),
      part(' ', 33.08, 0.001, 0),
      part('TO', 33.085, 9, 6)
    ])
  ).toBe('INTENTION-TO')
  expect(
    joinPdfSmallCapsLine([part('WORD', 0, 15, 6), part(' ', 15, 0.003, 0), part('.', 17, 3, 8)])
  ).toBe('WORD .')
})

it('keeps tightly bracketed lowered subscripts in the caption line', () => {
  const lines = [
    { text: 'Table 2 Plasma (C', x: 10, y: 20, width: 80, height: 7, fontSize: 7 },
    { text: 'min', x: 90, y: 25.1, width: 7, height: 4.2, fontSize: 4.2 },
    { text: ') of treatment', x: 97, y: 20, width: 70, height: 7, fontSize: 7 }
  ]
  expect(groupPageLines({ lines }).map((l: { text: string }) => l.text)).toEqual([
    'Table 2 Plasma (Cmin) of treatment'
  ])
  expect(groupPageLines({ lines: [lines[0], { ...lines[1], y: 31 }, lines[2]] })).toHaveLength(3)
  expect(groupPageLines({ lines: [lines[0], lines[1]] })).toHaveLength(2)
  expect(lines[1]).not.toHaveProperty('inlineSubscript')
})

it('recognizes an explicit unnumbered flow diagram caption, not an inline figure reference', () => {
  expect(captionKind('Figure n Flow diagram of participant selection.')).toBe('figure')
  expect(captionKind('Figure shows the treatment response.')).toBeUndefined()
})

it('keeps a raised numeric reference between adjoining title fragments on the same baseline', () => {
  const lines = [
    {
      text: 'Baseline characteristics by randomized group',
      x: 78,
      y: 100,
      width: 182,
      height: 10,
      fontSize: 10
    },
    { text: '1', x: 260, y: 96.5, width: 6, height: 7.5, fontSize: 7.9 },
    { text: '(N=50)', x: 266, y: 100, width: 30, height: 10, fontSize: 10 }
  ]
  expect(groupPageLines({ lines }).map((r: { text: string }) => r.text)).toEqual([
    'Baseline characteristics by randomized group¹ (N=50)'
  ])
  expect(
    groupPageLines({ lines: lines.map((l) => (l.text === '1' ? { ...l, y: 85 } : l)) })
  ).toHaveLength(2)
})

it('excludes a table reference wrapped after an explicit preceding prose reference', () => {
  const title = {
    text: 'Table 1 for accurate determination of stock solutions.',
    x: 285,
    y: 320,
    width: 216,
    height: 10,
    fontSize: 10
  }
  const before = { ...title, text: '[12] using extinction coefficients as listed in', y: 308 }
  expect(findCaptionCandidates([{ pageNumber: 1, lines: [before, title] }])).toEqual([])
  for (const previous of [
    { ...before, y: 280 },
    { ...before, x: 45 },
    { ...before, text: 'The results are summarized below.' }
  ]) {
    expect(findCaptionCandidates([{ pageNumber: 1, lines: [previous, title] }])).toHaveLength(1)
  }
})

it('places a delayed native subscript beside its source anchor before following prose', () => {
  // 12270199.pdf, page 11, Table 5 note: the stream paints w after the sentence.
  const items = [
    { str: 'κ', width: 4.448, height: 8.282314652317915, transform: [8, 0, 2.144, 8, 281.58, 163] },
    { str: ' ', width: 0.88775, height: 0, transform: [8, 0, 2.144, 8, 286.028, 163] },
    {
      str: 'values comparing the three urine collections. It is the percent agreement',
      width: 240.872,
      height: 8,
      transform: [8, 0, 0, 8, 293.13, 163]
    },
    { str: 'w', width: 3.61, height: 4.5, transform: [5, 0, 0, 4.5, 286.03, 161] }
  ]
  const original = structuredClone(items)
  expect(joinPdfSmallCapsLine(items)).toBe(
    'κw values comparing the three urine collections. It is the percent agreement'
  )
  expect(items).toEqual(original)
  for (const marker of [
    { ...items[3], height: 8 },
    { ...items[3], transform: [5, 0, 0, 4.5, 290, 161] },
    { ...items[3], transform: [5, 0, 0, 4.5, 286.03, 163] },
    { ...items[3], transform: [5, 0, 0, 4.5, 286.03, 155] }
  ])
    expect(joinPdfSmallCapsLine([...items.slice(0, 3), marker])).toBe(
      items.map((i) => i.str).join('')
    )
})
