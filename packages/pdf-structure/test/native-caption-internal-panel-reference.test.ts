import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { applyRuledCaptionRecovery, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)

function paragraph(): ReturnType<typeof JSON.parse> {
  const texts = [
    'FIG. 4: Independent measurements across the available trials',
    'The complete observations are compared under matching native conditions',
    'with the independent reference shown in',
    'Figure 3b. Further native measurements provide the comparison',
    'and finish.'
  ]
  const lines = texts.map((text, index) => ({
    text,
    x: [80, 70, 70, 70, 270][index],
    y: 400 + index * 18,
    width: [440, 460, 460, 460, 60][index],
    height: 10,
    fontSize: 10
  }))
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines,
    graphicsBounds: [
      { kind: 'image', normalizedRect: [100 / 600, 200 / 800, 500 / 600, 390 / 800] }
    ]
  }
  const fonts = lines.map((line, index) => ({
    text: line.text,
    sourceItem: { pageNumber: 1, index, text: line.text },
    rect: [line.x, line.y, line.x + line.width, line.y + line.height],
    height: line.height,
    baseline: line.y + line.height,
    horizontal: true
  }))
  return { page, fonts }
}

it('keeps a wrapped panel reference inside its complete native centered caption', () => {
  const { page, fonts } = paragraph(),
    before = structuredClone(page)
  const captions = findCaptionCandidates([page])
  applyRuledCaptionRecovery(captions, findCaptionCandidates([page]), page, [], fonts)
  expect(captions).toHaveLength(1)
  expect(captions[0].lines).toEqual(page.lines.map((line: { text: string }) => line.text))
  expect(captions[0].rect).toEqual([70, 400, 530, 482])
  expect(page).toEqual(before)
})

it.each([
  'missing-source',
  'duplicate-source',
  'changed-literal',
  'broken-cadence',
  'closed-before-reference',
  'missing-graphic'
])('requires complete independent paragraph evidence: %s', (change) => {
  const { page, fonts } = paragraph()
  if (change === 'missing-source') fonts.splice(2, 1)
  if (change === 'duplicate-source') fonts.push(structuredClone(fonts[2]))
  if (change === 'changed-literal') fonts[2].sourceItem.text += ' changed'
  if (change === 'broken-cadence') page.lines[3].y += 1
  if (change === 'closed-before-reference') {
    page.lines[2].text += '.'
    fonts[2].text += '.'
    fonts[2].sourceItem.text += '.'
  }
  if (change === 'missing-graphic') page.graphicsBounds = []
  const captions = findCaptionCandidates([page])
  applyRuledCaptionRecovery(captions, findCaptionCandidates([page]), page, [], fonts)
  expect(
    captions.some((caption: { lines: string[] }) => /^Figure 3b\./.test(caption.lines[0]))
  ).toBe(true)
  expect(captions[0].lines).not.toHaveLength(5)
})
