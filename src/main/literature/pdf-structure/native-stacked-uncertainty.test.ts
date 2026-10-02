import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeStackedUncertainty } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-stacked-uncertainty.mjs'))
    .href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-three-baseline-stacked-decimal-pair.jsonl'
    )
  )
it('serializes each native stacked error in its own source baseline order', () => {
  const x = fixture(),
    r = refineTable(x.table, x.items, x.captions, [], x.rules),
    cell = r.cells.find((c: { text: string }) => c.text.includes('6.84'))
  expect(cell?.text).toBe('6.84+0.27−0.39')
  expect(cell?.textRuns).toEqual([
    { text: '6.84', position: 'normal' },
    { text: '+0.27', position: 'superscript' },
    { text: '−0.39', position: 'subscript' }
  ])
  expect(cell?.sourceRects).toHaveLength(x.items.length)
})
it('preserves every source fragment and character without mutating native input', () => {
  const x = fixture(),
    before = JSON.stringify(x.items),
    p = recoverNativeStackedUncertainty(x.items, x.rules)
  expect(p?.ownedTokens.size).toBe(x.items.length)
  expect(JSON.stringify(x.items)).toBe(before)
  const native = x.items.flatMap((i: { text: string }) => [...i.text]).sort(),
    emitted = p.runs.flatMap((r: { text: string }) => [...r.text]).sort()
  expect(emitted).toEqual(native)
})
it.each([
  'one-sided',
  'same-sized scripts',
  'ordinary multiline',
  'nonadjacent',
  'different lane',
  'competing baseline',
  'repeated source',
  'rule between',
  'prose',
  'missing decimal'
])('declines an unproved stack: %s', (variant) => {
  const x = fixture()
  if (variant === 'one-sided')
    x.items = x.items.filter((i: { baseline: number }) => i.baseline !== 55)
  if (variant === 'same-sized scripts')
    for (const i of x.items.filter((i: { height: number }) => i.height === 10)) i.height = 14
  if (variant === 'ordinary multiline')
    for (const i of x.items.filter((i: { baseline: number }) => i.baseline === 55)) i.baseline += 15
  if (variant === 'nonadjacent')
    for (const i of x.items.filter((i: { height: number }) => i.height === 10)) {
      i.rect[0] += 8
      i.rect[2] += 8
    }
  if (variant === 'different lane')
    for (const i of x.items.filter((i: { baseline: number }) => i.baseline === 55)) {
      i.rect[0] += 4
      i.rect[2] += 4
    }
  if (variant === 'competing baseline')
    x.items.push({ ...x.items[0], rect: [20, 50, 27, 64], baseline: 64 })
  if (variant === 'repeated source') x.items.push(x.items[0])
  if (variant === 'rule between') x.rules.push([10, 45, 100, 45])
  if (variant === 'prose') x.items[0].text = 'value'
  if (variant === 'missing decimal') x.items.splice(5, 1)
  expect(recoverNativeStackedUncertainty(x.items, x.rules)).toBeUndefined()
})

it('allows only a table-proven tiny font-box overhang at the exact native divider', () => {
  const x = fixture(),
    top = Math.min(...x.items.map((i: { rect: number[] }) => i.rect[1])),
    divider = top + 0.05,
    rules = [[10, divider, 100, divider]],
    descriptor = { tokens: new Set(x.items), divider, smallFontBoundary: true }
  expect(recoverNativeStackedUncertainty(x.items, rules)).toBeUndefined()
  const p = recoverNativeStackedUncertainty(x.items, rules, [descriptor])
  expect(p?.runs.map((r: { text: string }) => r.text).join('')).toBe('6.84+0.27−0.39')
  expect(p?.ownedTokens.size).toBe(x.items.length)
})
it.each([
  'different divider',
  'competing proof',
  'incomplete owner',
  'excess overhang',
  'second divider',
  'missing sign'
])('rejects an ambiguous boundary stack: %s', (variant) => {
  const x = fixture(),
    divider = Math.min(...x.items.map((i: { rect: number[] }) => i.rect[1])) + 0.05,
    rules = [[10, divider, 100, divider]],
    descriptor = { tokens: new Set(x.items), divider, smallFontBoundary: true },
    context = [descriptor]
  if (variant === 'different divider') descriptor.divider += 1
  if (variant === 'competing proof') context.push(descriptor)
  if (variant === 'incomplete owner') descriptor.tokens.delete(x.items[0])
  if (variant === 'excess overhang')
    for (const i of x.items.filter(
      (i: { baseline: number }) =>
        i.baseline === Math.min(...x.items.map((t: { baseline: number }) => t.baseline))
    ))
      i.rect[1] -= 0.5
  if (variant === 'second divider') rules.push([10, divider + 1, 100, divider + 1])
  if (variant === 'missing sign') x.items.find((i: { text: string }) => i.text === '+').text = '0'
  expect(recoverNativeStackedUncertainty(x.items, rules, context)).toBeUndefined()
})
