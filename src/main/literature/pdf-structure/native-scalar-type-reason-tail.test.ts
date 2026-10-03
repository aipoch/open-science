import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { recoverNativeScalarTypeReasonTail } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-bounded-text-record-grid.mjs')
  ).href
)

type Token = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
}

type Input = {
  rows: { rect: number[]; origin: string }[]
  items: Token[]
  columnRects: number[][]
  rules: number[][]
}

const token = (text: string, left: number, top: number, width: number, height = 10): Token => ({
  text,
  rect: [left, top, left + width, top + height],
  baseline: top + height,
  height,
  horizontal: true
})

const input = (): Input => {
  const columns = [
    [0, 100],
    [100, 200],
    [200, 300],
    [300, 380],
    [380, 600],
    [600, 650],
    [650, 900]
  ]
  const rows = [
    { rect: [0, 0, 900, 12], origin: 'source-text' },
    { rect: [0, 20, 900, 40], origin: 'model' },
    { rect: [0, 40, 900, 60], origin: 'model' },
    { rect: [0, 60, 900, 80], origin: 'model' },
    { rect: [0, 80, 900, 110], origin: 'model' }
  ]
  const items: Token[] = [
    token('1.4000', 310, 25, 45),
    token('E1', 610, 25, 20),
    token('Reason begins', 660, 25, 100),
    token('1.4100', 310, 45, 45),
    token('M1', 610, 45, 20),
    token('Reason continues', 660, 45, 120),
    token('1.4200', 310, 65, 45),
    token('E2', 610, 65, 20),
    token('Tail line', 660, 85, 55),
    token('1.4300', 310, 95, 45),
    token('E1', 610, 95, 20),
    token('Next reason', 660, 95, 100)
  ]
  return {
    rows,
    items,
    columnRects: columns,
    rules: [
      [0, 12, 900, 12],
      [0, 18, 900, 18],
      [0, 110, 900, 110]
    ]
  }
}

it('moves a native reason continuation into the preceding scalar/type record', () => {
  const f = input(),
    repairs: string[] = []
  expect(
    recoverNativeScalarTypeReasonTail({
      rows: f.rows,
      items: f.items,
      columnRects: f.columnRects,
      rules: f.rules,
      repairs
    })
  ).toBeUndefined()
  expect(f.rows[3].rect[3]).toBe(80)
  expect(f.rows[4].rect[1]).toBe(80)
})

it.each([
  'not seven columns',
  'separator between tail',
  'missing next scalar',
  'missing type anchor',
  'tail crosses reason gutter'
])('declines an unproved native tail: %s', (variant) => {
  const f = input(),
    repairs: string[] = []
  if (variant === 'not seven columns') f.columnRects = f.columnRects.slice(0, 6)
  if (variant === 'separator between tail') f.rules.splice(2, 0, [0, 78, 900, 78])
  if (variant === 'missing next scalar') f.items = f.items.filter((i) => i.text !== '1.4300')
  if (variant === 'missing type anchor')
    f.items = f.items.filter((i) => i.text !== 'E1' || i.baseline < 80)
  if (variant === 'tail crosses reason gutter') {
    const tail = f.items.find((i) => i.text === 'Tail line')!
    tail.rect[0] = 620
    tail.rect[2] = 680
  }
  expect(
    recoverNativeScalarTypeReasonTail({
      rows: f.rows,
      items: f.items,
      columnRects: f.columnRects,
      rules: f.rules,
      repairs
    })
  ).toBeUndefined()
  expect(repairs).toEqual([])
})
