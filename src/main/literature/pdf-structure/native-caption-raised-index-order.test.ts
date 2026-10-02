import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { nativeCaptionRaisedIndexLines } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-caption-script-order.mjs'))
    .href
)
const input = (): ReturnType<typeof JSON.parse> => ({
  page: {
    lines: [
      { text: 'Table 1. Native quantities.', x: 50, y: 40, width: 300, height: 9, fontSize: 9 },
      { text: 'Measured component σ', x: 50, y: 52, width: 200, height: 9, fontSize: 9 },
      { text: 'a', x: 250.3, y: 51.2, width: 4, height: 6, fontSize: 6 },
      { text: 'bc. Native explanation.', x: 250, y: 52, width: 120, height: 10.8, fontSize: 9 },
      { text: 'Final sentence.', x: 50, y: 64, width: 70, height: 9, fontSize: 9 }
    ]
  },
  caption: { lines: ['Table 1. Native quantities.'], rect: [50, 40, 370, 73] }
})
it('orders literal raised and lowered native indices at their shared base edge', () => {
  const f = input()
  expect(nativeCaptionRaisedIndexLines(f.page, f.caption)).toEqual([
    'Table 1. Native quantities.',
    'Measured component σ a bc. Native explanation.',
    'Final sentence.'
  ])
})
it.each(['inline', 'far', 'ambiguous-base', 'nonfinite', 'outside-caption', 'ordinary-tail'])(
  'rejects an unproved caption index: %s',
  (reason) => {
    const f = input()
    if (reason === 'inline') f.page.lines[2].y = 55
    if (reason === 'far') f.page.lines[2].x = 254
    if (reason === 'ambiguous-base') f.page.lines.push({ ...f.page.lines[1] })
    if (reason === 'nonfinite') f.page.lines[2].width = NaN
    if (reason === 'outside-caption') f.caption.rect[2] = 350
    if (reason === 'ordinary-tail') f.page.lines[3].height = 9
    expect(nativeCaptionRaisedIndexLines(f.page, f.caption)).toBeUndefined()
  }
)
