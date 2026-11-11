import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)

function input(): ReturnType<typeof JSON.parse> {
  const line = (text: string, y: number, width = 470): ReturnType<typeof JSON.parse> => ({
    text,
    x: 70,
    y,
    width,
    height: 10,
    fontSize: 10
  })
  return {
    page: {
      pageNumber: 1,
      width: 612,
      height: 792,
      rotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds: [],
      lines: [
        line(
          'Table 1 completes the results with an independent evaluation for the same groups in the',
          250
        ),
        line(
          'second setting. The native paragraph discusses complete comparison measurements and the',
          262
        ),
        line(
          'evaluation remains separate from the printed title directly above the native table frame.',
          274
        ),
        line('including ties.', 286, 65),
        line('Table 1 Review quality across independent groups.', 310, 360),
        { ...line('Group Value Count', 332, 300), x: 145 },
        ...[360, 380, 400].map((y) => ({ ...line('Group 1 2.00 3.00', y, 300), x: 145 }))
      ]
    },
    rules: [
      [137, 330, 475, 330],
      [137, 350, 475, 350],
      [137, 420, 475, 420]
    ]
  }
}

it('keeps the independent printed title and rejects its complete same-number preceding body paragraph', () => {
  const f = input(),
    before = structuredClone(f)
  const captions = findCaptionCandidates([f.page], new Map([[1, f.rules]]))
  expect(captions.map((c: ReturnType<typeof JSON.parse>) => c.lines[0])).toEqual([
    f.page.lines[4].text
  ])
  expect(f).toEqual(before)
})

it.each([
  'no-closing',
  'broken-opening',
  'intervening-source',
  'competing-title',
  'unfinished-body',
  'not-full-paragraph',
  'independent-raster',
  'independent-path',
  'gap-raster',
  'gap-path'
])('does not suppress a candidate without %s proof', (reason) => {
  const f = input()
  if (reason === 'no-closing') f.rules.pop()
  if (reason === 'broken-opening') f.rules[0][2] = 250
  if (reason === 'intervening-source')
    f.page.lines.push({ ...f.page.lines[4], y: 324, text: 'Independent owner.' })
  if (reason === 'competing-title')
    f.page.lines.push({ ...f.page.lines[4], y: 298, text: 'Table 1 Independent measurements.' })
  if (reason === 'unfinished-body') f.page.lines[3].text = 'including ties and'
  if (reason === 'not-full-paragraph') f.page.lines[1].width = 200
  if (reason === 'independent-raster' || reason === 'independent-path')
    f.page.graphicsBounds.push({
      kind: reason === 'independent-raster' ? 'image' : 'path',
      normalizedRect: [0.2, 299 / 792, 0.8, 306 / 792]
    })
  if (reason === 'gap-raster' || reason === 'gap-path')
    f.page.graphicsBounds.push({
      kind: reason === 'gap-raster' ? 'image' : 'path',
      normalizedRect: [0.2, 323 / 792, 0.8, 327 / 792]
    })
  expect(
    findCaptionCandidates([f.page], new Map([[1, f.rules]])).some(
      (c: ReturnType<typeof JSON.parse>) => c.lines[0] === f.page.lines[0].text
    )
  ).toBe(true)
})
