import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const module = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_QUESTION_GRID_MODULE ??
        'resources/pdf-structure/literature-pdf-long-question-record-grid.mjs'
    )
  ).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-cohort-continuation-with-wrapped-count-stubs.jsonl'
    )
  )
const recover = (x: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  module.recoverNativeCohortRecordGrid?.(x.table, x.items, x.captions, x.rules)
it('retains native three lanes and both directions of wrapped paired-count stubs', () => {
  const x = fixture(),
    proof = recover(x)
  expect(proof?.columns).toHaveLength(3)
  expect(proof?.rows).toHaveLength(8)
  expect(proof?.ownedTokens.size).toBe(x.items.length)
  expect(proof?.cropRect[0]).toBeLessThan(x.items[0].rect[0])
  expect(proof?.cropRect[2]).toBeGreaterThan(x.table.cropRect[2])
})
it.each([
  'missing closing',
  'closing loses lane',
  'missing pair',
  'wrong model schema',
  'crossing field',
  'unproved prose',
  'unmatched tail',
  'distant tail'
])('rejects an unproved cohort continuation: %s', (variant) => {
  const x = fixture()
  if (variant === 'missing closing') x.rules = []
  if (variant === 'closing loses lane') x.rules.pop()
  if (variant === 'missing pair') x.items.splice(2, 1)
  if (variant === 'wrong model schema') x.table.structure.objects.pop()
  if (variant === 'crossing field') x.items[0].rect[2] = 150
  if (variant === 'unproved prose')
    x.items.push({
      ...x.items[0],
      text: 'unrelated article prose',
      rect: [44, 101, 130, 109],
      baseline: 109
    })
  if (variant === 'unmatched tail')
    x.items.find((i: ReturnType<typeof JSON.parse>) => i.text === 'continued tail').rect[0] = 60
  if (variant === 'distant tail') {
    const i = x.items.find((i: ReturnType<typeof JSON.parse>) => i.text === 'continued tail')
    i.rect[1] += 80
    i.rect[3] += 80
    i.baseline += 80
    x.table.cropRect[3] += 80
    x.rules.forEach((r: number[]) => {
      r[1] += 80
      r[3] += 80
    })
  }
  expect(recover(x)).toBeUndefined()
})

it('preserves both copies of the native two-tier sample-qualified header', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-repeated-cohort-sample-headers.jsonl'
    )
  ) as ReturnType<typeof fixture>
  const proof = recover(x)
  expect(proof?.headerRows).toHaveLength(2)
  expect(proof?.ownedTokens.size).toBe(x.items.length)
})
it.each(['caption absent', 'sample mismatch', 'changed repeated header'])(
  'rejects an unproved repeated cohort header: %s',
  (variant) => {
    const x = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/native-repeated-cohort-sample-headers.jsonl'
      )
    ) as ReturnType<typeof fixture>
    if (variant === 'caption absent') x.captions = []
    else if (variant === 'sample mismatch')
      x.items.filter((i: ReturnType<typeof JSON.parse>) => i.text === 'n=17').at(-1).text = 'n=18'
    else
      x.items
        .filter((i: ReturnType<typeof JSON.parse>) => i.text === 'Characteristic')
        .at(-1).text = 'Different heading'
    expect(recover(x)).toBeUndefined()
  }
)
