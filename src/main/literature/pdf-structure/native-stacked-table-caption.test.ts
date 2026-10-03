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
it('keeps upper captions when native header boxes slightly overhang their opening rules', () => {
  const f = input()
  f.tables[0].rect[1] = 238.5
  f.tables[0].rect[0] = 55
  f.tables[0].rect[2] = 295
  for (const r of f.rules.slice(0, 2)) {
    r[0] = 55
    r[2] = 295
  }
  f.captions[0].rect[3] = 227.5
  f.captions[0].rect[1] = 207.5
  f.tables[1].rect[1] = 349.8
  expect(
    associateTableCaptions(f.page, f.tables, f.captions, f.rules).map(
      (r: ReturnType<typeof JSON.parse>) => r.caption
    )
  ).toEqual(f.captions.slice(0, 2))
})
const omittedUpperHeaders = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.tables[0].rect = [55, 250, 295, 303]
  f.rules[0] = [55, 238.9, 295, 238.9]
  f.rules[1] = [55, 306.8, 295, 306.8]
  f.page.lines.push(
    { text: 'Success rate', x: 95, y: 240, width: 50, height: 5, fontSize: 5 },
    { text: 'Response latency', x: 160, y: 240.2, width: 65, height: 5, fontSize: 5 }
  )
  return f
}
it('keeps the upper title when two separate native header labels prove the omitted header band', () => {
  const f = omittedUpperHeaders()
  expect(
    associateTableCaptions(f.page, f.tables, f.captions, f.rules).map(
      (r: ReturnType<typeof JSON.parse>) => r.caption
    )
  ).toEqual(f.captions.slice(0, 2))
})
it.each(['missing-labels', 'one-label', 'crosses-row', 'prose-font', 'overlapping-labels'])(
  'does not widen the opening gap for omitted headers without %s proof',
  (reason) => {
    const f = omittedUpperHeaders()
    if (reason === 'missing-labels') f.page.lines.splice(-2)
    if (reason === 'one-label') f.page.lines.pop()
    if (reason === 'crosses-row') f.page.lines.at(-1).y = 247
    if (reason === 'prose-font')
      f.page.lines.slice(-2).forEach((l: ReturnType<typeof JSON.parse>) => (l.fontSize = 8))
    if (reason === 'overlapping-labels') f.page.lines.at(-1).x = 110
    expect(
      associateTableCaptions(f.page, f.tables, f.captions, f.rules).every(
        (r: ReturnType<typeof JSON.parse>) => r.caption
      )
    ).toBe(false)
  }
)
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
