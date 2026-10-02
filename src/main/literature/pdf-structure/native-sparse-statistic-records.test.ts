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
      'src/main/literature/pdf-structure/fixtures/source-grids/native-sparse-eight-field-statistical-continuation.jsonl'
    )
  )
const recover = (x: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  module.recoverNativeSparseModelRecordGrid?.(x.table, x.items, x.captions, x.rules)
it('preserves all eight native lanes and each standard-error value with its label', () => {
  const x = fixture(),
    proof = recover(x)
  expect(proof?.columns).toHaveLength(8)
  expect(proof?.rows).toHaveLength(8)
  expect(proof?.ownedTokens.size).toBe(x.items.length)
  expect(proof?.spans).toContainEqual({ row: 0, column: 0, rowSpan: 1, colSpan: 8 })
})
it.each([
  'missing opening',
  'closing loses lane',
  'inconsistent values',
  'missing statistic',
  'foreign prose',
  'crossing field'
])('rejects an unproved sparse statistical frame: %s', (variant) => {
  const x = fixture()
  if (variant === 'missing opening') x.rules.shift()
  if (variant === 'closing loses lane') x.rules.pop()
  if (variant === 'inconsistent values') x.items.splice(6, 1)
  if (variant === 'missing statistic') x.items[3].text = 'Other label'
  if (variant === 'foreign prose') x.items[0].text = 'Table 7. Another independent display'
  if (variant === 'crossing field') x.items[6].rect[2] = 125
  expect(recover(x)).toBeUndefined()
})

it('retains a bounded leading section overhang above its native opening rule', () => {
  const x = fixture()
  x.items[0].rect[1] = 99.6
  x.items[0].rect[3] = 107.6
  x.items[0].baseline = 107.6
  expect(recover(x)?.ownedTokens.size).toBe(x.items.length)
})
it.each(['large overhang', 'foreign footer', 'deep footer', 'number above opening'])(
  'rejects unsupported boundary ink: %s',
  (variant) => {
    const x = fixture()
    if (variant.includes('footer')) {
      x.items.push({
        text: variant === 'foreign footer' ? 'article body prose' : '* indicates p<0.02',
        horizontal: true,
        height: 8,
        baseline: 251,
        rect: [44, variant === 'deep footer' ? 241 : 243.6, 175, 251]
      })
    } else {
      x.items[0].rect[1] = variant === 'large overhang' ? 98 : 99.6
      if (variant === 'number above opening') x.items[0].text = '41'
    }
    expect(recover(x)).toBeUndefined()
  }
)
it('keeps the external statistical footer outside cells when its em box touches the closing stroke', () => {
  const x = fixture()
  x.items.push({
    text: '* indicates p<0.02',
    horizontal: true,
    height: 8,
    baseline: 251.6,
    rect: [44, 243.6, 175, 251.6]
  })
  expect(recover(x)?.ownedTokens.size).toBe(x.items.length - 1)
})
