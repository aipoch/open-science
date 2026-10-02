import { expect, test } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { recoverNativeStackedRecordGrid, recoverNativeStackedRecordRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-stacked-records.mjs')).href
)

type Item = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
function input(): { table: unknown; items: Item[]; captions: unknown[]; rules: number[][] } {
  const items: Item[] = []
  const token = (text: string, x: number, y: number, h = 10, width = text.length * 3): void => {
    items.push({ text, rect: [x, y - h, x + width, y], baseline: y, height: h, horizontal: true })
  }
  for (let c = 0; c < 9; c++) token(`H${c}`, c * 40 + 5, 27)
  for (let r = 0; r < 5; r++) {
    const y = 45.5 + r * 20
    for (let c = 0; c < 9; c++) {
      if (c !== 5) token(c === 0 ? `Record ${r}` : `${r + c}`, c * 40 + 5, y)
      else {
        token('10.0', c * 40 + 5, y)
        token('+1.0', c * 40 + 17, y - 4, 7)
        token('−0.5', c * 40 + 17, y + 3.5, 7)
      }
    }
  }
  const rules = [10, 12.5, 35, 132].map((y) => [0, y, 360, y])
  for (let c = 1; c < 9; c++) rules.push([c * 40, 12.5, c * 40, 132])
  return {
    table: {
      cropRect: [-1, 9, 361, 133],
      structure: {
        objects: Array.from({ length: 9 }, (_, c) => ({
          label: 'table column',
          rect: [1 + c * 40, 0, 41 + c * 40, 124]
        }))
      }
    },
    items,
    captions: [{ lines: ['Table 1. Measured records'], rect: [0, -8, 100, 4] }],
    rules
  }
}

test('recovers complete native record bands and first stacked field crossing only the divider font box', () => {
  const a = input()
  const p = recoverNativeStackedRecordGrid(a.table, a.items, a.captions, a.rules)
  expect(p?.rows).toHaveLength(6)
  expect(p?.columns).toHaveLength(9)
  expect(p?.ownedTokens.size).toBe(a.items.length)
  const field = a.items.filter(
    (i) => i.rect[0] >= 200 && i.rect[2] < 240 && i.baseline > 35 && i.baseline < 50
  )
  expect(recoverNativeStackedRecordRuns(field, p?.nativeStackedRecordRuns)).toEqual([
    { text: '10.0', position: 'normal' },
    { text: '+1.0', position: 'superscript' },
    { text: '−0.5', position: 'subscript' }
  ])
})

for (const kind of [
  'missing divider',
  'missing footer',
  'missing field',
  'foreign',
  'header overlap',
  'detached script',
  'wrong font',
  'ambiguous caption',
  'cross opening',
  'cross closing',
  'top gap'
] as const) {
  test(`rejects native stacked records with ${kind}`, () => {
    const a = input()
    if (kind === 'missing divider') a.rules.splice(2, 1)
    if (kind === 'missing footer') a.rules.splice(3, 1)
    if (kind === 'missing field')
      a.items.splice(
        a.items.findIndex((i) => i.text === '−0.5'),
        1
      )
    if (kind === 'foreign')
      a.items.push({
        text: 'Foreign',
        rect: [8, 49, 26, 59],
        baseline: 59,
        height: 10,
        horizontal: true
      })
    if (kind === 'header overlap') a.items[5].rect[3] = 36
    if (kind === 'detached script') {
      const i = a.items.find((i) => i.text === '+1.0')!
      i.rect[0] += 9
      i.rect[2] += 9
    }
    if (kind === 'wrong font') a.items.find((i) => i.text === '+1.0')!.height = 10
    if (kind === 'ambiguous caption') a.captions.push(structuredClone(a.captions[0]))
    if (kind === 'cross opening')
      a.items.push({
        text: 'Foreign',
        rect: [8, 9.7, 26, 14],
        baseline: 14,
        height: 4.3,
        horizontal: true
      })
    if (kind === 'cross closing')
      a.items.push({
        text: 'Foreign',
        rect: [8, 131.8, 26, 137],
        baseline: 137,
        height: 5.2,
        horizontal: true
      })
    if (kind === 'top gap')
      a.items.push({
        text: 'Foreign',
        rect: [8, 10.2, 26, 12],
        baseline: 12,
        height: 1.8,
        horizontal: true
      })
    expect(recoverNativeStackedRecordGrid(a.table, a.items, a.captions, a.rules)).toBeUndefined()
  })
}

test('renderer requires the complete unique source set and finite unchanged geometry', () => {
  const a = input()
  const p = recoverNativeStackedRecordGrid(a.table, a.items, a.captions, a.rules)
  const field = a.items.filter(
    (i) => i.rect[0] >= 200 && i.rect[2] < 240 && i.baseline > 35 && i.baseline < 50
  )
  expect(recoverNativeStackedRecordRuns(field.slice(1), p?.nativeStackedRecordRuns)).toBeUndefined()
  expect(
    recoverNativeStackedRecordRuns([...field, field[0]], p?.nativeStackedRecordRuns)
  ).toBeUndefined()
  expect(
    recoverNativeStackedRecordRuns(field, p?.nativeStackedRecordRuns, [
      { text: '10.0', position: 'normal' },
      { text: '+1.0', position: 'superscript' },
      { text: '−0.5', position: 'subscript' }
    ])
  ).toBeUndefined()
  field[0].rect[0] = Number.NaN
  expect(recoverNativeStackedRecordRuns(field, p?.nativeStackedRecordRuns)).toBeUndefined()
})

function unitInput(): ReturnType<typeof input> {
  const a = input()
  a.items = []
  const token = (text: string, x: number, y: number, h = 10, width = text.length * 3): void => {
    a.items.push({ text, rect: [x, y - h, x + width, y], baseline: y, height: h, horizontal: true })
  }
  for (let c = 0; c < 11; c++) {
    token(`H${c}`, c * 40 + 5, 27)
    if (c >= 2) token('[u]', c * 40 + 5, 47)
  }
  token('a', 91, 22)
  for (let r = 0; r < 5; r++) {
    const y = 65.5 + r * 20
    for (let c = 0; c < 11; c++) {
      if (c < 2) token(c ? '0' : `Record ${r}`, c * 40 + 5, y)
      else if (r === 4 && c === 2) token('—', c * 40 + 5, y)
      else {
        token('10.0', c * 40 + 5, y)
        token('+1.0', c * 40 + 17, y - 4, 7)
        token('−0.5', c * 40 + 17, y + 3.5, 7)
        if (c === 10) token('Q', c * 40 + 30, y)
      }
    }
  }
  a.rules = [10, 12.5, 55, 155].map((y) => [0, y, 440, y])
  a.table = {
    cropRect: [-1, 9, 441, 156],
    structure: {
      objects: Array.from({ length: 11 }, (_, c) => ({
        label: 'table column',
        rect: [1 + c * 40, 0, 41 + c * 40, 147]
      }))
    }
  }
  return a
}

test('preserves two native header bands, literal superscript, repeated normal suffix and printed blank field', () => {
  const a = unitInput()
  const p = recoverNativeStackedRecordGrid(a.table, a.items, a.captions, a.rules)
  expect(p?.rows).toHaveLength(7)
  expect(p?.headerRows).toEqual([0, 1])
  expect(p?.spans).toEqual([
    { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
    { row: 0, column: 1, rowSpan: 2, colSpan: 1 }
  ])
  const tail = a.items.filter((i) => i.rect[0] >= 400 && i.baseline > 55 && i.baseline < 70)
  expect(recoverNativeStackedRecordRuns(tail, p?.nativeStackedRecordRuns)?.at(-1)).toEqual({
    text: 'Q',
    position: 'normal'
  })
  const heading = a.items.filter((i) => i.rect[0] >= 80 && i.rect[2] < 120 && i.baseline < 35)
  expect(recoverNativeStackedRecordRuns(heading, p?.nativeStackedRecordRuns)).toEqual([
    { text: 'H2', position: 'normal' },
    { text: 'a', position: 'superscript' }
  ])
  const blank = a.items.filter((i) => i.text === '—')
  expect(recoverNativeStackedRecordRuns(blank, p?.nativeStackedRecordRuns)).toEqual([
    { text: '—', position: 'normal' }
  ])
})

for (const kind of [
  'missing unit band',
  'missing complete peer',
  'isolated suffix',
  'intersecting suffix',
  'cross column'
] as const) {
  test(`rejects the unit-band layout with ${kind}`, () => {
    const a = unitInput()
    if (kind === 'missing unit band') a.items = a.items.filter((i) => i.text !== '[u]')
    if (kind === 'missing complete peer')
      a.items = a.items.filter((i) => !(i.text === '−0.5' && i.rect[0] < 120 && i.baseline > 75))
    if (kind === 'isolated suffix')
      a.items = a.items.filter((i) => i.text !== 'Q' || i.baseline < 70)
    if (kind === 'intersecting suffix') {
      const i = a.items.find((i) => i.text === 'Q')!
      i.rect[0] -= 3
      i.rect[2] -= 3
    }
    if (kind === 'cross column') {
      const i = a.items.find((i) => i.text === 'Q')!
      i.rect[0] += 10
      i.rect[2] += 10
    }
    expect(recoverNativeStackedRecordGrid(a.table, a.items, a.captions, a.rules)).toBeUndefined()
  })
}
