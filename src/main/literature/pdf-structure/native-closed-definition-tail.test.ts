import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { findClosedDefinitionTailFrame, recoverClosedDefinitionTail } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-closed-definition-tail.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverClosedCellGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-column-grid.mjs')).href
)

it.each([
  'native',
  'missing-edge',
  'different-column',
  'occupied-other-lane',
  'uppercase-start',
  'unfinished-tail',
  'ended-prior-definition',
  'missing-prior-records',
  'crossing-ink',
  'first-page'
])('recovers only a uniquely proven closed definition tail: %s', (variant) => {
  type Token = {
    text: string
    rect: number[]
    height: number
    baseline: number
    horizontal: boolean
  }
  const previous: Token[] = [],
    current: Token[] = [],
    xs = [0, 50, 220, 280, 340, 430, 500],
    ys = [100, 130, 600, 1100, 1650]
  const token = (target: Token[], text: string, x: number, y: number, width = 15): void => {
    target.push({
      text,
      rect: [x, y - 10, x + width, y],
      height: 10,
      baseline: y,
      horizontal: true
    })
  }
  const priorRules = ys.map((y) => [0, y, 500, y])
  for (let r = 0; r < ys.length - 1; r++)
    for (const x of xs) priorRules.push([x, ys[r], x, ys[r + 1]])
  for (const [text, x, width] of [
    ['Symbol', 5, 35],
    ['Definition', 60, 80],
    ['Units', 225, 30],
    ['Low', 285, 25],
    ['Reference', 345, 70],
    ['High', 435, 25]
  ] as const)
    token(previous, text, x, 120, width)
  for (const y of [200, 700, 1500]) {
    token(previous, 'k', 5, y, 8)
    token(previous, 'A complete native definition of measured physical quantities', 60, y, 150)
    token(previous, y === 1500 ? 'a limitation of' : 'a definition ending here.', 60, y + 20, 120)
    token(previous, 's', 225, y, 5)
    token(previous, '1.25', 285, y, 25)
    token(previous, '(Group, 2021)', 345, y, 70)
    token(previous, '2.75', 435, y, 25)
  }
  const currentRules = [[0, 100, 500, 100], [0, 145, 500, 145], ...xs.map((x) => [x, 100, x, 145])]
  token(current, 'continuing definition', 60, 115, 120)
  token(current, 'process, Eq. (4)', 60, 130, 100)
  token(current, 'Unrelated notes below', 0, 180, 150)
  if (variant === 'missing-edge') currentRules.pop()
  if (variant === 'different-column') {
    currentRules[4][0] += 3
    currentRules[4][2] += 3
  }
  if (variant === 'occupied-other-lane') token(current, 'other', 435, 125, 20)
  if (variant === 'uppercase-start') current[0].text = 'Continuing definition'
  if (variant === 'unfinished-tail') current[1].text = 'process continues'
  if (variant === 'ended-prior-definition')
    previous.find((i) => i.text === 'a limitation of')!.text += '.'
  if (variant === 'missing-prior-records')
    for (const i of previous.filter((i) => i.text === '(Group, 2021)')) i.text = 'unowned'
  if (variant === 'crossing-ink') token(current, 'crossing', 210, 125, 20)
  const before = structuredClone({ previous, current, priorRules, currentRules })
  const frame = findClosedDefinitionTailFrame(current, currentRules, 1800),
    table = recoverClosedDefinitionTail(
      frame,
      previous,
      priorRules,
      variant === 'first-page' ? 1 : 2,
      1800
    )
  if (variant === 'native') {
    expect(frame).toBeDefined()
    expect(
      recoverClosedCellGrid(
        { cropRect: [0, 100, 500, 1650], structure: { objects: [] } },
        previous,
        [],
        priorRules
      )
    ).toBeDefined()
    expect(table).toBeDefined()
    const result = refineTable(table, current, [], [], currentRules)
    expect(result.grid).toEqual([['', 'continuing definition process, Eq. (4)', '', '', '', '']])
    expect(result.unassigned).toEqual([])
    expect(
      result.cells.flatMap((cell: { sourceRects: number[][] }) => cell.sourceRects)
    ).toHaveLength(2)
  } else expect(table).toBeUndefined()
  expect({ previous, current, priorRules, currentRules }).toEqual(before)
})
