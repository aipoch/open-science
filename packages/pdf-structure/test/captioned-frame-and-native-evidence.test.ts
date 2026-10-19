import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const resource = (name: string): string =>
  pathToFileURL(resolve('resources', `literature-pdf-${name}.mjs`)).href
const { findCaptionCandidates } = await import(resource('caption-group'))
const { associateFigures } = await import(resource('association'))
const { associateTableNotes } = await import(resource('table-notes'))
const { hasTableEvidence } = await import(resource('table-evidence'))
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids', name + '.jsonl'))

it.each([
  'raster-plate-inside-captioned-frame',
  'flowchart-below-caption-inside-frame',
  'localized-numbered-figure-caption'
])('retains the complete caption-owned graphic: %s', (name) => {
  const { page, rules } = fixture(name)
  const captions = findCaptionCandidates([page])
  const figures = associateFigures(
    page,
    captions,
    [],
    rules.map((r: number[]) => r.map((v) => v / 1.5))
  )
  expect(figures.filter((f: { rect?: number[] }) => f.rect)).toHaveLength(1)
  const rect = figures[0].rect
  if (name === 'flowchart-below-caption-inside-frame') {
    expect(rect[1]).toBeGreaterThan(captions[0].rect[3])
    expect(rect[3]).toBeGreaterThan(573)
  }
})

it('retains a double-spaced continuation below an isolated figure', () => {
  const { page } = fixture('double-spaced-caption-below-isolated-plate')
  expect(findCaptionCandidates([page])[0].lines).toHaveLength(2)
})

function boundedUnpunctuatedCaption(): ReturnType<typeof JSON.parse> {
  const lines = [
    'Figure 1: The measured response is compared across the complete set of observations',
    'The symbols indicate the measurements while the lines represent the predicted',
    'branches'
  ]
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds: [{ kind: 'image', normalizedRect: [0.1, 0.1, 0.85, 0.4] }],
    lines: [
      ...lines.map((text, i) => ({
        text,
        x: 60,
        y: 350 + i * 17.5,
        width: i < 2 ? 440 : 180,
        height: 10,
        fontSize: 10
      })),
      {
        text: 'The next paragraph discusses a separate experimental comparison.',
        x: 60,
        y: 430,
        width: 440,
        height: 10,
        fontSize: 10
      }
    ]
  }
}
it('retains a short unpunctuated caption tail before a distinct native paragraph', () => {
  const page = boundedUnpunctuatedCaption()
  expect(findCaptionCandidates([page])[0].lines).toEqual(
    page.lines.slice(0, 3).map((line: { text: string }) => line.text)
  )
})
it.each(['no-graphic', 'close-body', 'long-tail', 'different-font', 'different-pitch'])(
  'does not extend an unpunctuated caption without a complete bounded block: %s',
  (variant) => {
    const page = boundedUnpunctuatedCaption()
    if (variant === 'no-graphic') page.graphicsBounds = []
    if (variant === 'close-body') page.lines[3].y = 410
    if (variant === 'long-tail') page.lines[2].width = 440
    if (variant === 'different-font') page.lines[2].fontSize = 14
    if (variant === 'different-pitch') page.lines[2].y += 4
    expect(findCaptionCandidates([page])[0].lines).not.toContain('branches')
  }
)

const isolatedUppercaseCaption = (): ReturnType<typeof JSON.parse> => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  graphicsBounds: [{ kind: 'image', normalizedRect: [0.1, 0.1, 0.85, 0.4] }],
  lines: [
    {
      text: 'Figure 1: Measurements collected in three example',
      x: 60,
      y: 350,
      width: 440,
      height: 10,
      fontSize: 10
    },
    {
      text: 'LAB specimens show similar responses across all regions, while',
      x: 60,
      y: 367,
      width: 440,
      height: 10,
      fontSize: 10
    },
    {
      text: 'OTHER measurements provide the complementary result.',
      x: 60,
      y: 384,
      width: 300,
      height: 10,
      fontSize: 10
    }
  ]
})

it('retains uppercase continuations in a complete isolated caption with repeated native pitch', () => {
  const page = isolatedUppercaseCaption()
  expect(findCaptionCandidates([page])[0].lines).toEqual(
    page.lines.map((line: { text: string }) => line.text)
  )
})

it.each([
  'no image',
  'second image',
  'closed first line',
  'different pitch',
  'different font',
  'different alignment',
  'second caption',
  'intervening prose'
])('does not extend an uppercase caption without isolated block proof: %s', (variant) => {
  const page = isolatedUppercaseCaption()
  if (variant === 'no image') page.graphicsBounds = []
  if (variant === 'second image') page.graphicsBounds.push({ ...page.graphicsBounds[0] })
  if (variant === 'closed first line') page.lines[0].text += '.'
  if (variant === 'different pitch') page.lines[2].y += 5
  if (variant === 'different font') page.lines[2].fontSize = 12
  if (variant === 'different alignment') page.lines[2].x += 20
  if (variant === 'second caption') page.lines[2].text = 'Figure 2: Independent measurements.'
  if (variant === 'intervening prose')
    page.lines.push({
      text: 'Independent paragraph beside the caption.',
      x: 300,
      y: 360,
      width: 250,
      height: 10,
      fontSize: 10
    })
  expect(findCaptionCandidates([page])[0].lines).toEqual([page.lines[0].text])
})

it.each([
  'structured-abstract-with-clipped-prose',
  'bibliographic-tail-with-page-number',
  'numbered-affiliations-in-model-columns'
])('rejects native non-table evidence: %s', (name) => {
  const { table, tokens } = fixture(name)
  expect(hasTableEvidence(table, undefined, tokens)).toBe(false)
})

it('associates separately painted raised note letters despite their full-size font boxes', () => {
  const { page, tables, rules } = fixture('full-size-raised-letter-table-notes')
  const notes = associateTableNotes(page, tables, rules)[0]
  expect(notes).toHaveLength(3)
  expect(notes[1].text).toMatch(/^a Adjusted/)
  expect(notes[2].text).toMatch(/^b Adjusted/)
})
it.each([
  [
    'framed-vector-plots-beside-prose',
    (rect: number[]) => rect[0] > 50 && rect[2] < 290 && rect[3] > 715
  ],
  ['legend-section-heading-above-raster-plate', (rect: number[]) => rect[1] > 90],
  ['running-logo-and-rule-above-raster-plate', (rect: number[]) => rect[1] > 65 && rect[2] < 400]
] as const)('excludes external text and page furniture: %s', (name, check) => {
  const { page, rules } = fixture(name),
    captions = findCaptionCandidates([page])
  const figures = associateFigures(page, captions, [], rules)
  expect(figures).toHaveLength(1)
  expect(check(figures[0].rect)).toBe(true)
})
