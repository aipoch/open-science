import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'numbered-footnote-native-wrap.jsonl'
)[0]
function extract(page: PdfLayoutPage): ReturnType<typeof groupPdfTranslationPages> {
  const result = groupPdfTranslationPages({ pages: [page] })
  const native = page.items.flatMap((item, index) =>
    item.str.trim() ? [[`1:${index}`, item.str]] : []
  )
  const actual = result.units.flatMap((unit) =>
    unit.items.map((key, index) => [key, unit.originalStrings[index]])
  )
  expect(actual.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual(
    native.toSorted((a, b) => a[0].localeCompare(b[0]))
  )
  expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
  return result
}

it('keeps complete paired numeric notes separate from each other and the body', () => {
  const { units } = extract(structuredClone(fixture.page))
  for (const [number, head] of [1, 4, 7].entries()) {
    const owner = units.find((unit) => unit.items.includes(`1:${head}`))!
    expect(owner.items).toEqual([head, head + 1, head + 2].map((index) => `1:${index}`))
    expect(owner.source).toBe(
      [String(number + 1), fixture.page.items[head + 1].str, fixture.page.items[head + 2].str].join(
        ' '
      )
    )
    expect(owner.sourceOnly).toBeUndefined()
    expect(owner.items).not.toContain('1:0')
  }
})

it.each([
  'missing-peer',
  'marker-font',
  'body-font',
  'body-rail',
  'marker-rise',
  'marker-size',
  'marker-gap',
  'native-interruption',
  'same-row-foreign',
  'high-on-page',
  'missing-eol'
])('rejects an unproven numeric note continuation: %s', (fault) => {
  const page = structuredClone(fixture.page),
    items = page.items
  if (fault === 'missing-peer') items.splice(4)
  if (fault === 'marker-font') items[1].fontFamily = 'serif'
  if (fault === 'body-font') items[3].fontName = 'different'
  if (fault === 'body-rail') items[3].transform[4] += 5
  if (fault === 'marker-rise') items[1].transform[5] = items[2].transform[5]
  if (fault === 'marker-size') {
    items[1].transform[0] = items[1].transform[3] = items[1].height = 9
  }
  if (fault === 'marker-gap') items[1].transform[4] -= 8
  if (fault === 'native-interruption' || fault === 'same-row-foreign') {
    items.splice(3, 0, {
      ...items[3],
      str: 'Independent neighboring text.',
      width: 100,
      transform: [9, 0, 0, 9, 360, fault === 'same-row-foreign' ? 173 : 178.5]
    })
  }
  if (fault === 'high-on-page') for (const item of items) item.transform[5] += 150
  if (fault === 'missing-eol') items[2].hasEOL = false
  const { units } = extract(page),
    owner = units.find((unit) => unit.items.includes('1:1'))!
  const tailIndex = fault === 'native-interruption' || fault === 'same-row-foreign' ? 4 : 3
  expect(owner.items).not.toContain(`1:${tailIndex}`)
  if (fault === 'same-row-foreign') expect(owner.items).not.toContain('1:3')
})

const scripted = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'scripted-footnote-citation-wrap.jsonl'
)[0]

it('keeps paired numbered notes with inline subscripts and their own wrapped citations', () => {
  const { units } = extract(structuredClone(scripted.page))
  const first = units.find((unit) => unit.items.includes('1:1'))!
  const second = units.find((unit) => unit.items.includes('1:8'))!
  expect(first.items).toEqual([1, 2, 3, 4, 6].map((index) => `1:${index}`))
  expect(second.items).toEqual([8, 9, 10, 11, 13].map((index) => `1:${index}`))
  expect(first.source).toContain('R3 [Ref24].')
  expect(second.source).toContain('R3 under mild assumptions [Ref25].')
})

it.each(['missing-peer', 'citation-rail'])(
  'keeps the unmatched citation separate when the scripted note lacks proof: %s',
  (fault) => {
    const page = structuredClone(scripted.page)
    if (fault === 'missing-peer') page.items.splice(7)
    else page.items[6].transform[4] -= 24
    const { units } = extract(page)
    expect(units.find((unit) => unit.items.includes('1:6'))?.items).toEqual(['1:6'])
  }
)

it.each(['bounded', 'wrong marker', 'other typeface', 'shifted rail'])(
  'keeps a final wrapped title with its numbered note only with native proof (%s)',
  (shape) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontName: string,
      hasEOL = false
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      fontFamily: 'sans-serif',
      fontAscent: 0.7,
      fontDescent: -0.2,
      fontVertical: false,
      transform: [height, 0, 0, height, x, y],
      hasEOL
    })
    const marker = shape === 'wrong marker' ? '5' : '4'
    const continuation = run(
      'Visible from the valley observatory?',
      shape === 'shifted rail' ? 70 : 62,
      75,
      130,
      8,
      shape === 'other typeface' ? 'regular' : 'italic'
    )
    const items = [
      run('The first series gave a period near 0.00397', 56, 129, 319, 10, 'body'),
      run(marker, 375, 132.6, 4, 7, 'reference'),
      run(', measured using the small telescope.', 379.5, 129, 173, 10, 'body', true),
      run('We retained the unusual data points for later study.', 50, 116.5, 510, 10, 'body'),
      run('4', 55, 87.3, 4, 6, 'note-number'),
      run('This observation was announced in the', 62, 84.5, 128, 8, 'regular'),
      run('Local Forum 2018', 194, 84.5, 61, 8, 'italic'),
      run('and', 259, 84.5, 14, 8, 'regular'),
      run('Autumn Workshop 2018', 278, 84.5, 84, 8, 'italic'),
      run('in the presentation', 368, 84.5, 72, 8, 'regular'),
      run('Is a Second Peak', 445, 84.5, 113, 8, 'italic', true),
      continuation
    ]
    const { units } = extract({ page: 1, rotation: 0, width: 612, height: 792, items })
    const owner = units.find((unit) => unit.items.includes('1:4'))!
    const tailKey = '1:' + items.indexOf(continuation)
    expect(owner.items.includes(tailKey)).toBe(shape === 'bounded')
    if (shape === 'bounded') {
      expect(owner.fragments).toHaveLength(2)
      expect(owner.source).toContain('Is a Second Peak Visible from the valley observatory?')
    }
  }
)

it.each(['numbered', 'wrong callout', 'independent prose'])(
  'preserves the last URL marker and literal independently of the preceding note (%s)',
  (variant) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 8,
      fontName = 'note',
      hasEOL = false
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      fontAscent: 0.7,
      fontDescent: -0.2,
      fontVertical: false,
      transform: [height, 0, 0, height, x, y],
      hasEOL
    })
    const marker = '5'
    const note = 'The published counts exclude samples with damaged seals.'
    const url = 'https://reports.example/series.measure ment.summary.html'
    const call = (text: string, mark: string, y: number): PdfLayoutPage['items'] => [
      run(text, 51, y, 204, 10, 'body'),
      run(mark, 255, y + 3.7, 4, 7, 'callout'),
      run('and the later observations confirm the result.', 264, y, 290, 10, 'body', true)
    ]
    const footer = [
      run(marker, 55, 82.8, 3.6, 6, 'numeral'),
      run(note, 62, 80, 270),
      run('6', 55, 71.9, 3.6, 6, 'numeral'),
      run(variant === 'independent prose' ? 'A separate observation.' : url, 62, 69.1, 313)
    ]
    const items = [
      ...call('The published total covers the first interval.', marker, 249),
      ...call(
        'The dataset is available with the original report',
        variant === 'wrong callout' ? '8' : '6',
        173
      ),
      run(
        'The interval ended before the additional samples were collected.',
        51,
        115,
        460,
        10,
        'body',
        true
      ),
      ...footer
    ]
    const { units } = extract({ page: 1, width: 612, height: 792, rotation: 0, items })
    const head = items.indexOf(footer[0])
    const first = units.find((unit) => unit.items.includes(`1:${head}`))!
    const second = units.find((unit) => unit.items.includes(`1:${head + 2}`))!
    if (variant === 'numbered') {
      expect(first.source).toBe(`${marker} ${note}`)
      expect(first.items).toEqual([`1:${head}`, `1:${head + 1}`])
      expect(first.sourceOnly).toBeUndefined()
      expect(second.source).toBe(`6 ${url}`)
      expect(second.items).toEqual([`1:${head + 2}`, `1:${head + 3}`])
      expect(second.sourceOnly).toBe(true)
      expect(second.preserve).toBe('literal')
      expect(first.fragments[0].rect.bottom).toBeLessThan(second.fragments[0].rect.y)
    } else {
      expect(second.preserve).not.toBe('literal')
    }
  }
)

it.each([1, 2])('splits an acknowledgment before the body-linked footer note (%s)', (callout) => {
  const run = (
    str: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fontName: string,
    hasEOL = false
  ): PdfLayoutPage['items'][number] => ({
    str,
    width,
    height,
    dir: 'ltr',
    fontName,
    fontVertical: false,
    fontAscent: fontName === 'marker' ? 0.675 : 0.75,
    fontDescent: fontName === 'marker' ? -0.104 : -0.25,
    hasEOL,
    transform: [height, 0, 0, height, x, y]
  })
  const thanks = 'We acknowledge assistance from the Coastal Survey team.'
  const first = 'The calibration exercise requires checking the resistance of each contact before'
  const end = 'reporting the recorded drift.'
  const items = [
    run('We compare the measurements in the original order.', 72, 158, 380, 11, 'body', true),
    run('Later we complete the calibration procedure', 72, 145, 293, 11, 'body'),
    run(String(callout), 365, 149.2, 4, 8, 'marker'),
    run('. A shorter check is also available.', 369, 145, 170, 11, 'body', true),
    run('This concludes the first stage of the measurements.', 72, 132, 300, 11, 'body'),
    run(thanks, 84, 78.5, 304, 9, 'note'),
    run('1', 84, 70.1, 4, 8, 'marker'),
    run(first, 88, 66.6, 452, 9, 'note', true),
    run(end, 72, 55.6, 175, 9, 'note'),
    run('1', 304, 43.7, 4, 8, 'marker')
  ]
  const { units } = extract({ page: 1, width: 612, height: 792, rotation: 0, items })
  const acknowledgment = units.find((unit) => unit.items.includes('1:5'))!
  const note = units.find((unit) => unit.items.includes('1:6'))!
  expect(acknowledgment === note).toBe(callout !== 1)
  if (callout === 1) {
    expect(acknowledgment.source).toBe(thanks)
    expect(note.source).toBe('1' + first + ' ' + end)
    expect(note.items).toEqual(['1:6', '1:7', '1:8'])
    expect(acknowledgment.fragments[0].rect.bottom).toBeLessThan(note.fragments[0].rect.y)
  }
  expect(units.find((unit) => unit.items.includes('1:9'))?.preserve).toBe('literal')
})
