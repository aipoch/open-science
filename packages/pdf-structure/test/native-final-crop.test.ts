import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const {
  recoverNativeClosingRuleCrop,
  recoverNativeRightFrameCrop,
  recoverNativeAssignedFrameCrop
} = await import(pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href)

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

const assignedFrame = (): ReturnType<typeof JSON.parse> => {
  const grid = [
    ['Group', 'Value'],
    ['Alpha', '12'],
    ['Beta', '34']
  ]
  const cells = grid.flatMap((row, r) =>
    row.map((text, c) => {
      const token = item(text, [10 + c * 100, 10 + r * 20, c ? 192 : 45, 18 + r * 20])
      return {
        row: r,
        column: c,
        rowSpan: 1,
        colSpan: 1,
        text,
        sourceRects: [token.rect],
        sourceTokens: [token]
      }
    })
  )
  const prose = item(
    'The following source paragraph remains outside the closed table.',
    [5, 65, 198, 73]
  )
  return {
    table: {
      cropRect: [0, 0, 193, 68],
      grid,
      cells,
      issues: ['text-crosses-crop-boundary'],
      unassigned: [] as string[]
    },
    items: [...cells.flatMap((c) => c.sourceTokens), prose],
    rules: [
      [3, 5, 200, 5],
      [3, 24, 200, 24],
      [3, 62, 200, 62]
    ],
    clipped: [prose]
  }
}

it('restores an independently closed assigned frame and excludes the separate following paragraph', () => {
  const f = assignedFrame(),
    before = structuredClone(f)
  expect(recoverNativeAssignedFrameCrop(f.table, f.items, f.rules, f.clipped)).toEqual([
    0, 0, 200.5, 62.5
  ])
  expect(f).toEqual(before)
})

it.each([
  'competing-frame',
  'foreign-interior',
  'large-overhang',
  'no-closing',
  'incomplete-source',
  'mixed-issue',
  'overlapping-prose',
  'unassigned'
])('requires complete native assigned-frame evidence before restoring a crop: %s', (change) => {
  const f = assignedFrame()
  if (change === 'competing-frame') f.rules.push([3, 4, 200, 4], [3, 63, 200, 63])
  if (change === 'foreign-interior') f.items.push(item('Foreign label', [60, 30, 90, 38]))
  if (change === 'large-overhang') f.table.cropRect[2] = 190
  if (change === 'no-closing') f.rules.pop()
  if (change === 'incomplete-source') f.table.cells[0].sourceTokens = []
  if (change === 'mixed-issue') f.table.issues.push('native-table-structure-ambiguous')
  if (change === 'overlapping-prose') f.clipped[0].rect[1] = 62
  if (change === 'unassigned') f.table.unassigned.push('Unresolved label')
  expect(recoverNativeAssignedFrameCrop(f.table, f.items, f.rules, f.clipped)).toBeUndefined()
})
