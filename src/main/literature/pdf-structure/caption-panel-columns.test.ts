import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/panel-column-caption.jsonl')
)
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
