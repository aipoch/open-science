/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { recoverWrappedMeanSeRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-wrapped-mean-se.mjs')).href
)

type Token = {
  text: string
  rect: [number, number, number, number]
  baseline: number
  height: number
  horizontal: boolean
}

const token = (text: string, column: number, y: number): Token => {
  const left = column * 100 + 10
  return {
    text,
    rect: [left, y, left + 40, y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  }
}

const columns = Array.from({ length: 6 }, (_, column) => [column * 100, 0, column * 100 + 90, 70])
const row = (top: number, bottom: number) => ({ rect: [0, top, 590, bottom], origin: 'model' })

it('separates two model baselines and keeps their mean/SE columns aligned', () => {
  const items: Token[] = [
    token('Model A', 0, 8),
    token('1.10', 1, 8),
    token('2.20', 2, 8),
    token('3.30', 3, 8),
    token('(0.10)', 1, 20),
    token('(0.20)', 2, 20),
    token('(0.30)', 3, 20),
    token('Model B', 0, 38),
    token('4.40', 1, 38),
    token('5.50', 2, 38),
    token('6.60', 3, 38),
    token('(0.40)', 1, 50),
    token('(0.50)', 2, 50),
    token('(0.60)', 3, 50)
  ]
  const rows = [row(0, 70)]
  const repairs: string[] = []
  expect(recoverWrappedMeanSeRows({ rows, items, columnRects: columns, repairs })).toBe(true)
  expect(rows).toHaveLength(2)
  expect(rows.every((entry) => entry.rect[3] > entry.rect[1])).toBe(true)
  expect(
    rows.flatMap((entry) =>
      items.filter((item) => item.rect[1] >= entry.rect[1] && item.rect[3] <= entry.rect[3])
    )
  ).toHaveLength(items.length)
  expect(repairs).toEqual(['wrapped-mean-se-records-separated'])
})

it('merges a detached standard-error line only when several columns pair', () => {
  const items: Token[] = [
    token('Model C', 0, 8),
    token('1.10', 1, 8),
    token('2.20', 3, 8),
    token('3.30', 5, 8),
    token('(0.10)', 1, 23),
    token('(0.20)', 3, 23),
    token('(0.30)', 5, 23)
  ]
  const rows = [row(0, 20), row(20, 40)]
  const repairs: string[] = []
  expect(recoverWrappedMeanSeRows({ rows, items, columnRects: columns, repairs })).toBe(true)
  expect(rows).toHaveLength(1)
  expect(rows[0].rect).toEqual([0, 0, 590, 40])
  expect(repairs).toEqual(['wrapped-mean-se-continuation-recovered'])
})
