import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { pdfTextRunsSchema } from '../../../shared/pdf-structure'
import { readPdfFixture } from './read-fixture'
const { recoverNativeMixedSectionParts } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-mixed-section-parts.mjs'))
    .href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-adjoining-record-schemas.jsonl'
    )
  )
type Source = { text: string; rect: number[]; baseline: number; height: number }
type Cell = {
  text: string
  sourceRects: number[][]
  textRuns?: { text: string; position: string }[]
  rect: number[]
}
const recover = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  recoverNativeMixedSectionParts(f.table, f.items, f.captions, f.rules, f.observations)

it('keeps adjoining source schemas and native fraction literals in separate parts', () => {
  const f = fixture(),
    p = recover(f)
  expect(
    p.parts.map((part: { grid: string[][] }) => [part.grid.length, part.grid[0].length])
  ).toEqual([
    [6, 2],
    [6, 7],
    [6, 2],
    [6, 7]
  ])
  expect(p.parts.map((part: { title: string }) => part.title)).toEqual([
    'Section Alpha',
    'Section Alpha',
    'Section Beta',
    'Section Beta'
  ])
  const cells: Cell[] = p.parts.flatMap((part: { cells: Cell[] }) => part.cells)
  expect(
    cells
      .flatMap((c) => c.sourceRects)
      .map((r) => JSON.stringify(r))
      .sort()
  ).toEqual([...p.cellTokens].map((i: Source) => JSON.stringify(i.rect)).sort())
  expect(new Set(p.ownedTokens).size).toBe(p.cellTokens.size + p.titleTokens.size)
  for (const c of cells) {
    if (c.textRuns) expect(pdfTextRunsSchema.safeParse(c.textRuns).success).toBe(true)
    expect(
      c.sourceRects.every(
        (r) => r[0] >= c.rect[0] && r[1] >= c.rect[1] && r[2] <= c.rect[2] && r[3] <= c.rect[3]
      )
    ).toBe(true)
  }
  expect(
    cells.filter((c) => c.textRuns?.[0]?.position === 'superscript' && c.text === '12')
  ).toHaveLength(2)
  const codepoints = (s: string): string => [...s.replace(/\s/gu, '')].sort().join('')
  expect(
    codepoints(
      cells.map((c) => c.text).join('') +
        [...new Set(p.parts.map((part: { title: string }) => part.title))].join('')
    )
  ).toBe(codepoints(f.items.map((i: Source) => i.text).join('')))
})

it.each([
  'caption',
  'native separator',
  'title band',
  'closing pair',
  'measured header gap',
  'measured numeric gap',
  'fraction bar',
  'fraction peer',
  'missing numeric field',
  'foreign item',
  'crossing separator',
  'crossing opening from outside',
  'crossing closing from outside',
  'overlapping source lanes'
])('refuses incomplete mixed-schema proof: %s', (variant) => {
  const f = fixture()
  if (variant === 'caption') f.captions = []
  if (variant === 'native separator') f.rules = f.rules.filter((r: number[]) => r[0] !== r[2])
  if (variant === 'title band') f.rules = f.rules.filter((r: number[]) => r[1] !== 12.5)
  if (variant === 'closing pair') f.rules = f.rules.filter((r: number[]) => r[1] !== 242.5)
  if (variant === 'measured header gap') f.observations.shift()
  if (variant === 'measured numeric gap') f.observations.splice(1, 1)
  if (variant === 'fraction bar') f.rules = f.rules.filter((r: number[]) => r[2] - r[0] > 10)
  if (variant === 'fraction peer')
    f.items.find((i: Source) => i.text === '2' && i.height === 7).rect[0] += 5
  if (variant === 'missing numeric field')
    f.items.splice(
      f.items.findIndex((i: Source) => i.text === '5.67'),
      1
    )
  if (variant === 'foreign item')
    f.items.push({
      text: 'Outside',
      rect: [185, 55, 205, 65],
      height: 10,
      baseline: 65,
      horizontal: true
    })
  if (variant === 'crossing separator')
    f.items.find((i: Source) => i.text === 'FieldA').rect[2] = 205
  if (variant === 'crossing opening from outside')
    f.items.push({
      text: 'Foreign',
      rect: [20, 6, 55, 11],
      height: 5,
      baseline: 9,
      horizontal: true
    })
  if (variant === 'crossing closing from outside')
    f.items.push({
      text: 'Foreign',
      rect: [20, 238, 55, 248],
      height: 10,
      baseline: 248,
      horizontal: true
    })
  if (variant === 'overlapping source lanes')
    f.items.find((i: Source) => i.text === '3.21').rect[2] = 320
  expect(recover(f)).toBeUndefined()
})
