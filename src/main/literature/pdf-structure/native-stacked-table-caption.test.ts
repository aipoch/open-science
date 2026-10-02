import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> => {
  const captions = [
    { page: 1, lines: ['Table 2. Upper results.'], rect: [55, 210, 295, 230] },
    { page: 1, lines: ['Table 3. Lower results.'], rect: [55, 312, 298, 343] },
    {
      page: 1,
      lines: ['Table 1 do not sacrifice accuracy in a separate prose paragraph.'],
      rect: [55, 420, 298, 455]
    }
  ]
  const tables = [{ rect: [80, 240, 279, 303] }, { rect: [48, 351, 304, 410] }]
  const lines = captions.map((c) => ({
    text: c.lines[0],
    x: c.rect[0],
    y: c.rect[1],
    width: c.rect[2] - c.rect[0],
    height: 8,
    fontSize: 8
  }))
  for (const [x, y, w] of [
    [87, 255, 170],
    [55, 360, 240]
  ])
    for (let i = 0; i < 3; i++)
      lines.push({
        text: 'Group 1.00 2.00 3.00',
        x,
        y: y + i * 12,
        width: w,
        height: 8,
        fontSize: 8
      })
  return {
    page: { pageNumber: 1, width: 600, height: 800, lines, graphicsBounds: [] },
    captions,
    tables,
    rules: [
      [86.9, 238.9, 265.7, 238.9],
      [86.9, 306.8, 265.7, 306.8],
      [54.4, 350.1, 298.2, 350.1],
      [54.4, 413, 298.2, 413]
    ]
  }
}
it('associates both complete ruled tables with unique upper captions despite a nearby prose reference', () => {
  const f = input()
  expect(
    associateTableCaptions(f.page, f.tables, f.captions, f.rules).map(
      (r: ReturnType<typeof JSON.parse>) => r.caption
    )
  ).toEqual(f.captions.slice(0, 2))
})
it.each(['missing-closing', 'competing-opening', 'non-numeric-body', 'non-caption-title'])(
  'does not override competing caption distances without %s proof',
  (reason) => {
    const f = input()
    if (reason === 'missing-closing') f.rules.splice(1, 1)
    if (reason === 'competing-opening') f.rules.push([86.9, 239.4, 265.7, 239.4])
    if (reason === 'non-numeric-body')
      f.page.lines.forEach((l: ReturnType<typeof JSON.parse>) => {
        if (l.y === 267) l.text = 'Ordinary prose'
      })
    if (reason === 'non-caption-title') f.captions[0].lines = ['Table 2 reports upper results']
    expect(
      associateTableCaptions(f.page, f.tables, f.captions, f.rules).every(
        (r: ReturnType<typeof JSON.parse>) => r.caption
      )
    ).toBe(false)
  }
)
