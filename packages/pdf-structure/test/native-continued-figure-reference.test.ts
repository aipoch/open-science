import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativePrintedCaptionBodyReference } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-printed-caption-reference.mjs')).href
)

function fixture(): ReturnType<typeof JSON.parse> {
  const width = 600
  const height = 800
  const drawing = {
    kind: 'path',
    normalizedRect: [120, 105, 501, 470].map((v, n) => v / (n % 2 ? height : width))
  }
  const page = {
    pageNumber: 2,
    rotation: 0,
    width,
    height,
    invalidGraphicsBounds: 0,
    graphicsBounds: [drawing]
  }
  const previous = {
    pageNumber: 1,
    rotation: 0,
    width,
    height,
    lines: [
      {
        text: 'The two projections can be compared as shown in',
        x: 70,
        y: 740,
        width: 446,
        height: 12,
        fontSize: 12
      }
    ]
  }
  const row = (text: string, x: number, y: number, right: number, fontSize: number): object => ({
    text,
    x,
    y,
    right,
    bottom: y + fontSize,
    fontSize
  })
  const title = [
    'Figure 3. (Color print) Two normalized projections.',
    'The curves show the reference conditions.'
  ]
  const caption = { page: 2, rect: [143, 480, 516, 505], lines: title }
  const start = row('Fig. 3. The curves remain parallel under a small shift.', 70, 532, 516, 12)
  const runs = [
    row(title[0], 143, 480, 516, 10),
    row(title[1], 143, 495, 436, 10),
    start,
    row('The normalization is independent of the projection order.', 70, 548, 516, 12)
  ]
  return { page, previous, caption, start, runs }
}

it('recognizes a leading reference after a complete same-number printed caption', () => {
  const { page, previous, caption, start, runs } = fixture()
  expect(nativePrintedCaptionBodyReference(start, runs, page, [caption], previous)).toBe(true)
})

it.each(['closed earlier sentence', 'different number', 'second graphic', 'different body lane'])(
  'keeps the candidate with a %s',
  (kind) => {
    const { page, previous, caption, start, runs } = fixture()
    if (kind === 'closed earlier sentence')
      previous.lines[0].text = 'The preceding conditions are independent.'
    if (kind === 'different number') start.text = 'Fig. 4. A different measured response.'
    if (kind === 'second graphic')
      page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.64, 0.7, 0.66] })
    if (kind === 'different body lane') start.x += 15
    expect(nativePrintedCaptionBodyReference(start, runs, page, [caption], previous)).toBe(false)
  }
)
