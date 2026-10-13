import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/native-caption-paragraph-boundaries.jsonl'))

it('owns one taller interior native row only on the repeated closed caption baselines', () => {
  const text = [
    'Fig. 1. Measured distributions for all independent',
    'regions are drawn with the same boundary settings and',
    'all complete records are retained within the same region,',
    'including the measured X Y values across each region and',
    'the remaining complete comparisons are shown together with',
    'the final boundary.'
  ]
  const lines = text.map((text, i) => ({
    text,
    x: i ? 100 : 108,
    y: 200 + i * 11 - (i === 3 ? 1.25 : 0),
    width: i === 5 ? 100 : i ? 250 : 242,
    height: i === 3 ? 11.25 : 10,
    fontSize: i === 3 ? 11.25 : 10
  }))
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      ...lines,
      {
        text: 'The independent body paragraph starts beneath the figure.',
        x: 112,
        y: 280,
        width: 238,
        height: 12.5,
        fontSize: 12.5
      }
    ],
    graphicsBounds: [{ kind: 'image', normalizedRect: [100 / 600, 50 / 800, 350 / 600, 195 / 800] }]
  }
  expect(findCaptionCandidates([page])[0].lines).toEqual(text)
  for (const change of [
    'baseline',
    'second-outlier',
    'missing-row',
    'invalid',
    'graphic',
    'paint',
    'rule'
  ]) {
    const copy = structuredClone(page)
    if (change === 'baseline') copy.lines[3].y += 1.25
    if (change === 'second-outlier') {
      copy.lines[2].fontSize = 11.25
      copy.lines[2].height = 11.25
      copy.lines[2].y -= 1.25
    }
    if (change === 'missing-row') copy.lines.splice(2, 1)
    if (change === 'invalid') copy.lines[3].width = -250
    if (change === 'graphic') copy.graphicsBounds = []
    if (change === 'paint') copy.invalidGraphicsBounds = 1
    const rules = change === 'rule' ? new Map([[1, [[100, 240, 350, 240]]]]) : new Map()
    expect(findCaptionCandidates([copy], rules)[0].lines).not.toContain(text[5])
  }
})

it.each(['Tab. 2.', 'Fig. 2.'])(
  'retains a wrapped %s reference inside its complete native caption',
  (label) => {
    const texts = [
      'Fig. 1. Independent measurements across the observed regions.',
      'The complete measurements correspond to',
      `${label} The same measurements are shown with different scales,`,
      'and the remaining comparisons are measured independently.',
      'All regions are included.'
    ]
    const lines = texts.map((text, i) => ({
      text,
      x: 50,
      y: 300 + i * 11,
      width: i === 4 ? 170 : 500,
      height: 10,
      fontSize: 10
    }))
    const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [
        ...lines,
        {
          text: 'A new body paragraph starts below the complete caption.',
          x: 50,
          y: 380,
          width: 250,
          height: 11.2,
          fontSize: 11.2
        }
      ],
      graphicsBounds: [0, 1, 2].map((i) => ({
        kind: 'image',
        normalizedRect: [(70 + i * 150) / 600, 0.1, (200 + i * 150) / 600, 0.34]
      }))
    }
    expect(findCaptionCandidates([page]).map((c) => c.lines)).toEqual([texts])
    for (const change of ['closed-predecessor', 'font', 'rule', 'missing-graphic', 'invalid']) {
      const copy = structuredClone(page)
      if (change === 'closed-predecessor') copy.lines[1].text += '.'
      if (change === 'font') copy.lines[2].fontSize = 12
      if (change === 'missing-graphic') copy.graphicsBounds = []
      if (change === 'invalid') copy.lines[2].width = -500
      const rules = change === 'rule' ? new Map([[1, [[50, 321, 550, 321]]]]) : new Map()
      expect(findCaptionCandidates([copy], rules)[0].lines).not.toContain(copy.lines[2].text)
    }
  }
)

it('owns a short centered caption tail only inside a separated native caption band', () => {
  const line = (
    text: string,
    x: number,
    y: number,
    width: number,
    fontSize = 10
  ): {
    text: string
    x: number
    y: number
    width: number
    height: number
    fontSize: number
  } => ({ text, x, y, width, height: fontSize, fontSize })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      line('Fig.1. Comparison of the independent methods in the', 100, 300, 400),
      line('three observed coordinates, respectively.', 200, 318, 200),
      line('A separately led body paragraph follows the caption.', 100, 350, 400, 12)
    ],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [120 / 600, 100 / 800, 480 / 600, 280 / 800] }
    ]
  }
  expect(findCaptionCandidates([page])[0].lines).toEqual(page.lines.slice(0, 2).map((l) => l.text))
  for (const change of [
    'font',
    'miscentered',
    'missing-graphic',
    'rule',
    'invalid',
    'closed-title',
    'unknown-paint',
    'invalid-graphic'
  ]) {
    const copy = structuredClone(page)
    if (change === 'font') copy.lines[1].fontSize = 12
    if (change === 'miscentered') copy.lines[1].x += 25
    if (change === 'missing-graphic') copy.graphicsBounds = []
    if (change === 'invalid') copy.lines[1].width = -200
    if (change === 'closed-title') copy.lines[0].text += '.'
    if (change === 'unknown-paint') copy.invalidGraphicsBounds = 1
    if (change === 'invalid-graphic') copy.graphicsBounds[0].normalizedRect[2] = 0.1
    const rules = change === 'rule' ? new Map([[1, [[100, 314, 500, 314]]]]) : new Map()
    expect(findCaptionCandidates([copy], rules)[0].lines).not.toContain(copy.lines[1].text)
  }
})

it('retains a long native caption after a full-width intermediate sentence', () => {
  const page = fixture()[0]
  const before = structuredClone(page)
  const [caption] = findCaptionCandidates([page])
  expect(caption.lines).toEqual(page.lines.slice(0, 12).map((l: { text: string }) => l.text))
  expect(caption.rect[3]).toBeCloseTo(page.lines[11].y + page.lines[11].height)
  expect(caption.lines.join(' ')).not.toContain('A separate body paragraph')
  expect(page).toEqual(before)
})

it('does not borrow formula evidence from a separate paragraph after a closed short caption', () => {
  const page = fixture()[1]
  const before = structuredClone(page)
  const [caption] = findCaptionCandidates([page])
  expect(caption.lines).toEqual(page.lines.slice(0, 3).map((l: { text: string }) => l.text))
  expect(caption.rect[3]).toBeCloseTo(page.lines[2].y + page.lines[2].height)
  expect(caption.lines.join(' ')).not.toContain('independent predictions')
  expect(page).toEqual(before)
})

it('keeps a two-line closed caption separate from neighboring body formula fragments', () => {
  const page = fixture()[1]
  const removed = page.lines.splice(1, 1)[0]
  const leading = page.lines[1].y - removed.y
  for (const line of page.lines) if (line.y > removed.y) line.y -= leading
  const before = structuredClone(page)
  const [caption] = findCaptionCandidates([page])
  expect(caption.lines).toEqual(page.lines.slice(0, 2).map((l: { text: string }) => l.text))
  expect(caption.rect[3]).toBeCloseTo(page.lines[1].y + page.lines[1].height)
  expect(page).toEqual(before)
})

it.each([
  [0, 0.73],
  [0, 1.7],
  [1, 0.73],
  [1, 1.7]
])(
  'keeps native paragraph ownership under source reordering and scale (%s, %s)',
  (index, scale) => {
    const page = fixture()[index]
    const expected = findCaptionCandidates([page])[0].lines
    page.width *= scale
    page.height *= scale
    for (const line of page.lines)
      for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
    page.lines.reverse()
    const before = structuredClone(page)
    expect(findCaptionCandidates([page])[0].lines).toEqual(expected)
    expect(page).toEqual(before)
  }
)

it.each(['B', 'C', 'G', 'H', 'T', 'Z'])(
  'distinguishes a finite-verb appendix reference from a literal title (%s)',
  (prefix) => {
    expect(
      captionKind(`Figure ${prefix}1 separates the measured values into independent groups.`)
    ).toBeUndefined()
    expect(captionKind(`Figure ${prefix}1: Separate measurements for independent groups.`)).toBe(
      'figure'
    )
  }
)
