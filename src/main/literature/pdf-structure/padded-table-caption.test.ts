import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/padded-wide-table-with-close-caption.jsonl')
  )

it('associates a close title using a wide table’s native top rule despite narrow crop padding', () => {
  const f = fixture(),
    original = structuredClone(f)
  const matches = associateTableCaptions(f.page, f.tables, f.captions, f.rules)
  expect(matches.map((m: { caption?: { lines: string[] } }) => m.caption?.lines[0])).toEqual(
    f.captions.map((c: { lines: string[] }) => c.lines[0])
  )
  expect(f).toEqual(original)
})

it.each(['missing-rule', 'excessive-padding', 'embedded-caption'])(
  'leaves a padded caption unresolved with %s',
  (variant) => {
    const f = fixture()
    if (variant === 'missing-rule') f.rules = []
    else if (variant === 'excessive-padding') f.tables[0].rect[0] -= 20
    else f.captions[0].rect[1] = f.tables[0].rect[1] + 1
    expect(associateTableCaptions(f.page, f.tables, f.captions, f.rules)[0].caption).toBeUndefined()
  }
)

const paddedFooter = (): ReturnType<typeof JSON.parse> => ({
  page: {
    pageNumber: 1,
    width: 600,
    height: 800,
    graphicsBounds: [],
    lines: [
      { text: 'Variant 1.25 2.35 3.45', x: 70, y: 188, width: 210, height: 10, fontSize: 9 },
      {
        text: 'Table 2. Complete measurements for the final variants.',
        x: 50,
        y: 200,
        width: 250,
        height: 9,
        fontSize: 9
      }
    ]
  },
  tables: [{ rect: [50, 100, 300, 201] }],
  captions: [
    {
      page: 1,
      lines: ['Table 2. Complete measurements for the final variants.'],
      rect: [50, 200, 300, 209]
    }
  ],
  rules: [
    [90, 190, 90, 201],
    [160, 190, 160, 201],
    [230, 190, 230, 201]
  ]
})

it('retains a footer title when terminal native column segments pad beyond the complete numeric record', () => {
  const f = paddedFooter()
  expect(associateTableCaptions(f.page, f.tables, f.captions, f.rules)[0].caption).toEqual(
    f.captions[0]
  )
})
it.each([
  'missing-segments',
  'unequal-ends',
  'no-numeric-record',
  'crossing-record',
  'deep-overlap',
  'competing-table'
])('leaves an overlapping footer title unresolved without %s proof', (variant) => {
  const f = paddedFooter()
  if (variant === 'missing-segments') f.rules.pop()
  if (variant === 'unequal-ends') f.rules[0][3] = 203
  if (variant === 'no-numeric-record') f.page.lines[0].text = 'Ordinary narrative paragraph'
  if (variant === 'crossing-record') f.page.lines[0].height = 13
  if (variant === 'deep-overlap') f.tables[0].rect[3] = 205
  if (variant === 'competing-table') f.tables.push({ rect: [50, 300, 300, 400] })
  expect(associateTableCaptions(f.page, f.tables, f.captions, f.rules)[0].caption).toBeUndefined()
})
