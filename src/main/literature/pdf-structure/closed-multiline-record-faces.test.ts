import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledRecordFaces } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-record-faces.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/closed-multitier-header-with-wrapped-numeric-faces.jsonl'
    )
  )

it('keeps parenthesized numerical tails inside each complete native record face', () => {
  const f = fixture()
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.unassigned).toEqual([])
  expect(
    result.grid.some((row: string[]) => row[1] === '39.9 (25.9)' && row[3] === '42.5 (24.9)')
  ).toBe(true)
  expect(
    result.grid.some((row: string[]) => row[1] === '21.0 (3.5)' && row[3] === '8.0 (5.3)')
  ).toBe(true)
})

it.each(['separator', 'plain-tail', 'extra-value', 'duplicate', 'caption', 'missing-lane'])(
  'rejects multiline face recovery without %s evidence',
  (change) => {
    const f = fixture()
    const tail = f.tokens.find((i: { text: string }) => i.text === '(25.9)')
    if (change === 'separator')
      f.rules = f.rules.filter((r: number[]) => Math.abs(r[1] - 454.35) > 2)
    if (change === 'plain-tail') tail.text = '5.1'
    if (change === 'extra-value') f.tokens.push({ ...tail, text: '6.1', rect: [...tail.rect] })
    if (change === 'duplicate') f.tokens.push(tail)
    if (change === 'caption') f.captions = []
    if (change === 'missing-lane')
      f.tokens = f.tokens.filter(
        (i: { baseline: number; rect: number[] }) =>
          !(
            Math.abs(i.baseline - tail.baseline) < tail.height * 1.2 &&
            i.rect[0] > 323 &&
            i.rect[0] < 395
          )
      )
    expect(recoverRuledRecordFaces(f.table, f.tokens, f.captions, f.rules)?.repair).not.toBe(
      'native-body-records-recovered'
    )
  }
)
