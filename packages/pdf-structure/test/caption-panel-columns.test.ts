import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const fixture = readPdfFixture(resolve('test/fixtures/panel-column-caption.jsonl'))
it('completes a split panel legend using consecutive panel labels across columns', () => {
  const captions = findCaptionCandidates([structuredClone(fixture)])
  const caption = captions.find((c: { lines: string[] }) => c.lines[0].startsWith('Fig. 3'))
  expect(caption.lines.join(' ')).toContain(
    'NCG and BCS; C. Optimism comparison between NCG and BCS; D.'
  )
  expect(caption.lines.at(-1).replace(/\s/g, '')).toContain('p<0.01,*:p<0.05)')
  expect(caption.lines.join(' ')).not.toContain('Data analysis')
})
it.each(['nonconsecutive-panel', 'larger-font', 'complete-sentence'])(
  'rejects a neighboring column with %s',
  (condition) => {
    const page = structuredClone(fixture)
    for (const line of page.lines) {
      if (condition === 'nonconsecutive-panel')
        line.text = line.text.replace('C. Optimism', 'E. Optimism')
      if (condition === 'larger-font' && line.x > 300 && line.y > 510 && line.y < 550)
        line.fontSize = 12
      if (condition === 'complete-sentence')
        line.text = line.text.replace(
          /BCS; B. Adamancy comparison between$/,
          'BCS; B. Adamancy comparison completed.'
        )
    }
    const caption = findCaptionCandidates([page]).find((c: { lines: string[] }) =>
      c.lines[0].startsWith('Fig. 3')
    )
    expect(caption.lines.join(' ')).not.toContain('Optimism comparison between NCG and BCS; D.')
  }
)

it('retains a caption ending in a preposition beside a separate figure caption', () => {
  const width = 600,
    height = 800
  const row = (
    text: string,
    x: number,
    y: number,
    width: number
  ): {
    text: string
    x: number
    y: number
    width: number
    fontSize: number
    height: number
  } => ({ text, x, y, width, fontSize: 9, height: 9 })
  const left = row('Fig. 1. Sensor response across the full sweep.', 40, 152, 240)
  const right = [
    row('Fig. 2. Calibration at the reference setting. (a). Error rates in', 310, 151.8, 243),
    row('different operating conditions with independent instruments', 310, 164, 243),
    row('and typical noise levels; (b). Estimates for two different', 310, 175, 243),
    row('exposure settings with the reference instrument.', 310, 186, 205)
  ]
  const page = {
    pageNumber: 1,
    width,
    height,
    rotation: 0,
    invalidGraphicsBounds: 0,
    graphicsBounds: [
      { kind: 'image', normalizedRect: [0.065, 0.05, 0.48, 0.176] },
      { kind: 'image', normalizedRect: [0.51, 0.05, 0.93, 0.176] }
    ],
    lines: [
      left,
      ...right,
      row('A separate paragraph begins here and should not be consumed.', 40, 196, 242),
      row('Observed rates remained stable across all independent trials.', 310, 207, 248)
    ]
  }
  expect(findCaptionCandidates([page]).map((c: { lines: string[] }) => c.lines)).toEqual([
    [left.text],
    right.map(({ text }) => text)
  ])
})
