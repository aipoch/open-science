import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { recoverNativeClosingRuleCrop, recoverNativeRightFrameCrop } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

const item = (
  text: string,
  rect: number[],
  height = 8
): { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean } => ({
  text,
  rect,
  height,
  baseline: rect[3],
  horizontal: true
})
const cell = (
  row: number,
  text: string,
  rect: number[]
): { row: number; text: string; sourceRects: number[][] } => ({
  row,
  text,
  sourceRects: [rect]
})

const rightFrame = (): {
  crop: number[]
  cells: ReturnType<typeof cell>[]
  rules: number[][]
  clipped: ReturnType<typeof item>[]
} => ({
  crop: [0, 0, 300, 90],
  cells: [
    cell(0, 'Header', [10, 10, 70, 18]),
    cell(2, 'Row', [20, 50, 60, 58]),
    cell(2, '3.4', [120, 50, 135, 58]),
    cell(2, '-', [240, 50, 260, 58]),
    cell(3, 'Last', [20, 72, 40, 80])
  ],
  rules: [
    [3, 8, 306, 8],
    [3, 82, 306, 82]
  ],
  clipped: [item('-', [298.5, 50, 301.5, 58])]
})

it('recovers closing native frame ink without changing cell text or ownership', () => {
  const input = rightFrame()
  const before = structuredClone(input)
  expect(recoverNativeRightFrameCrop(input.crop, input.cells, input.rules, input.clipped)).toEqual([
    0, 0, 307, 90
  ])
  expect(input).toEqual(before)
})

it('requires both matching frame boundaries for a stray right-edge dash', () => {
  const input = rightFrame()
  expect(
    recoverNativeRightFrameCrop(input.crop, input.cells, input.rules.slice(1), input.clipped)
  ).toBeUndefined()
})

it('does not treat prose as recoverable right-edge frame ink', () => {
  const input = rightFrame()
  input.clipped[0].text = 'Following prose'
  expect(
    recoverNativeRightFrameCrop(input.crop, input.cells, input.rules, input.clipped)
  ).toBeUndefined()
})

it('requires the extra dash to align with an independently assigned record', () => {
  const input = rightFrame()
  input.clipped[0].rect = [298.5, 62, 301.5, 70]
  expect(
    recoverNativeRightFrameCrop(input.crop, input.cells, input.rules, input.clipped)
  ).toBeUndefined()
})

const proseBoundary = (): {
  crop: number[]
  cells: ReturnType<typeof cell>[]
  rules: number[][]
  pageItems: ReturnType<typeof item>[]
  clipped: ReturnType<typeof item>[]
} => {
  const prose = item(
    'As previously mentioned, the model uses three separate inputs.',
    [0, 112, 300, 122],
    10
  )
  return {
    crop: [0, 0, 300, 114],
    cells: [cell(3, '1.2', [40, 90, 250, 100])],
    rules: [[0, 110, 300, 110]],
    pageItems: [prose],
    clipped: [prose]
  }
}

it('retains closing rule ink while trimming the following page narrative', () => {
  const input = proseBoundary()
  const before = structuredClone(input)
  expect(
    recoverNativeClosingRuleCrop(
      input.crop,
      input.cells,
      input.pageItems,
      input.rules,
      input.clipped
    )
  ).toEqual([0, 0, 300, 111])
  expect(input).toEqual(before)
})

it('refuses a narrative trim without a full-width closing rule', () => {
  const input = proseBoundary()
  input.rules[0][2] = 200
  expect(
    recoverNativeClosingRuleCrop(
      input.crop,
      input.cells,
      input.pageItems,
      input.rules,
      input.clipped
    )
  ).toBeUndefined()
})

it('does not trim unmatched scalar content before the closing rule', () => {
  const input = proseBoundary()
  input.pageItems.push(item('99', [100, 102, 115, 108], 6))
  expect(
    recoverNativeClosingRuleCrop(
      input.crop,
      input.cells,
      input.pageItems,
      input.rules,
      input.clipped
    )
  ).toBeUndefined()
})

it('does not classify a table footnote as following narrative', () => {
  const input = proseBoundary()
  input.clipped[0].text = 'Note: these values use the same source and units.'
  expect(
    recoverNativeClosingRuleCrop(
      input.crop,
      input.cells,
      input.pageItems,
      input.rules,
      input.clipped
    )
  ).toBeUndefined()
})
