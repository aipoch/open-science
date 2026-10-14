import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverCaptionedRuledTables } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-regions.mjs')).href
)

const item = (text: string, x: number, y: number): object => ({
  text,
  rect: [x, y, x + 20, y + 8],
  baseline: y + 8,
  height: 8,
  horizontal: true
})
const frame = (y: number): number[][] => [
  [20, y, 220, y],
  [20, y + 20, 220, y + 20],
  [20, y + 80, 220, y + 80],
  [90, y, 90, y + 80],
  [155, y, 155, y + 80]
]
const records = (y: number): object[] =>
  ['Group', 'A', 'B', 'C'].flatMap((label, row) => [
    item(label, 30, y + 5 + row * 20),
    item(row ? '0.25' : 'Mean', 105, y + 5 + row * 20),
    item(row ? '0.05' : 'Spread', 175, y + 5 + row * 20)
  ])
const caption = (number: number, y: number, left = 20, right = 220): object => ({
  page: 1,
  lines: [`Table ${number}: Comparison.`],
  rect: [left, y, right, y + 8]
})

it('keeps two below-table captions with their own complete rule frames', () => {
  const recovered = recoverCaptionedRuledTables(
    [...records(20), ...records(125)],
    [...frame(20), ...frame(125)],
    [caption(1, 105), caption(2, 210)],
    1
  )
  expect(recovered.map((table: { cropRect: number[] }) => table.cropRect)).toEqual([
    [20, 20, 220, 100],
    [20, 125, 220, 205]
  ])
})

it('retains full-width rule evidence for a centered narrow caption', () => {
  const recovered = recoverCaptionedRuledTables(
    records(30),
    frame(30),
    [caption(1, 10, 80, 160)],
    1
  )
  expect(recovered).toHaveLength(1)
  expect(recovered[0].cropRect).toEqual([20, 30, 220, 110])
})

it('does not let partial fraction bars claim prose below a real table frame', () => {
  const items = [
    ...records(30),
    ...[0, 1, 2].flatMap((row) => [
      item('Proof 1', 105, 150 + row * 20),
      item('bound 2', 130, 150 + row * 20),
      item('term 3', 175, 150 + row * 20)
    ])
  ]
  const recovered = recoverCaptionedRuledTables(
    items,
    [...frame(30), [105, 150, 130, 150], [175, 210, 190, 210]],
    [caption(1, 10, 80, 160)],
    1
  )
  expect(recovered).toHaveLength(1)
  expect(recovered[0].cropRect).toEqual([20, 30, 220, 110])
})

it('uses repeated numeric gutters inside metric groups without dropping the stub', () => {
  const rules = [
    [20, 20, 240, 20],
    [20, 40, 240, 40],
    [20, 105, 240, 105],
    ...[20, 42, 62, 82].map((y) => [65, y, 65, y + 8])
  ]
  const items = [
    item('Method', 25, 25),
    item('Metrics', 115, 25),
    ...[45, 65, 85].flatMap((y) => [
      item('Group', 25, y),
      ...[75, 115, 155, 195].map((x) => item('0.25', x, y))
    ])
  ]
  const recovered = recoverCaptionedRuledTables(items, rules, [caption(1, 112, 20, 240)], 1)
  expect(recovered).toHaveLength(1)
  expect(
    recovered[0].structure.objects
      .filter((o: { label: string }) => o.label === 'table column')
      .map((o: { rect: number[] }) => [o.rect[0], o.rect[2]])
  ).toEqual([
    [0, 45],
    [45, 85],
    [85, 125],
    [125, 165],
    [165, 220]
  ])
})

it.each([
  ['intervening prose', [...records(20), item('Body', 105, 102)], frame(20)],
  ['missing closing rule', records(20), frame(20).filter((r) => r[1] !== 100)],
  ['crossing source text', [...records(20), item('Outside', 210, 50)], frame(20)]
])('does not recover a below-caption frame with %s', (_reason, items, rules) => {
  expect(recoverCaptionedRuledTables(items, rules, [caption(1, 114)], 1)).toEqual([])
})
