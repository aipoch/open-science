/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { isNativeFrontMatterRegion } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-front-matter.mjs')).href
)

const token = (text: string, x: number, y: number, width = 80) => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const table = (grid: string[][] = []) => ({ cropRect: [0, 0, 600, 500], grid })

it('rejects an uncaptioned first-page author and affiliation band', () => {
  const items = [
    token('Ada Lovelace', 20, 20),
    token('Grace Hopper', 220, 20),
    token('Alan Turing', 420, 20),
    token('Example University', 20, 50, 120),
    token('Example Department', 220, 50, 130),
    token('Example Institute', 420, 50, 110),
    token('ada@example.test', 20, 80, 100),
    token('grace@example.test', 220, 80, 110),
    token('alan@example.test', 420, 80, 100)
  ]
  expect(isNativeFrontMatterRegion(table(), items, 1, undefined, [])).toBe(true)
})

it('rejects an author/contact band that continues into an abstract prose block', () => {
  const items = [
    token('Ada Lovelace', 20, 20),
    token('Example University', 20, 50, 120),
    token('ada@example.test', 20, 80, 100),
    token('Abstract', 200, 110),
    token(
      'We study a method whose behavior is stable under perturbations and report consistent improvements across several evaluation settings.',
      20,
      140,
      550
    )
  ]
  expect(isNativeFrontMatterRegion(table(), items, 1, undefined, [])).toBe(true)
})

it('rejects a compact first-page author-list grid without contacts', () => {
  const authorGrid = table([
    ['Zhengming Yu1,2, Junkun Yuan2', 'Haotian Yang2, Gordon Qian2'],
    ['Yizhi Wang2, Angtian Wang2', 'Yiding Yang2, Bo Liu2, Xin Li1']
  ])
  const items = [
    token('Zhengming Yu1,2, Junkun Yuan2', 20, 20, 180),
    token('Haotian Yang2, Gordon Qian2', 220, 20, 180),
    token('Yizhi Wang2, Angtian Wang2', 20, 40, 180),
    token('Yiding Yang2, Bo Liu2, Xin Li1', 220, 40, 180)
  ]
  expect(isNativeFrontMatterRegion(authorGrid, items, 1, undefined, [])).toBe(true)
})

it('keeps captioned or source-proved numeric tables eligible', () => {
  const items = [
    token('Example University', 20, 20, 120),
    token('Example Department', 20, 50, 130),
    token('contact@example.test', 20, 80, 120),
    token('12', 220, 110, 15),
    token('34.5', 320, 110, 30),
    token('18', 220, 130, 15),
    token('29.1', 320, 130, 30)
  ]
  const numericTable = table([
    ['Institution', 'n', 'Mean'],
    ['Example University', '12', '34.5'],
    ['Example Department', '18', '29.1']
  ])
  expect(isNativeFrontMatterRegion(numericTable, items, 1, undefined, [])).toBe(false)
  expect(isNativeFrontMatterRegion(table(), items, 1, { lines: ['Table 1. Results'] }, [])).toBe(
    false
  )
})

it('keeps a closed native frame eligible and limits the gate to page one', () => {
  const items = [
    token('Ada Lovelace', 20, 20),
    token('Example University', 20, 50, 120),
    token('ada@example.test', 20, 80, 100),
    token('Grace Hopper', 220, 20),
    token('Example Institute', 220, 50, 110),
    token('grace@example.test', 220, 80, 110)
  ]
  const rules = [
    [0, 0, 600, 0],
    [0, 500, 600, 500],
    [0, 0, 0, 500],
    [600, 0, 600, 500]
  ]
  expect(isNativeFrontMatterRegion(table(), items, 1, undefined, rules)).toBe(false)
  expect(isNativeFrontMatterRegion(table(), items, 2, undefined, [])).toBe(false)
})
