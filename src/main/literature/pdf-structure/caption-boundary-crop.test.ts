/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { recoverCaptionBoundaryCrop } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-boundary-crop.mjs')).href
)
const token = (text: string, x: number, y: number) => ({
  text,
  rect: [x, y, x + 40, y + 10],
  height: 10,
  horizontal: true
})
const caption = (y: number) => ({
  lines: ['Table 2. Independent results'],
  rect: [50, y, 400, y + 12]
})

it('trims a preceding detector crop at the native separator before the next caption', () => {
  const table = { cropRect: [50, 100, 450, 260] }
  const items = [
    token('A', 60, 130),
    token('1', 180, 130),
    token('B', 60, 150),
    token('2', 180, 150),
    token('C', 60, 220),
    token('3', 180, 220)
  ]
  expect(recoverCaptionBoundaryCrop(table, items, [caption(270)], [[50, 200, 450, 200]])).toEqual([
    50, 100, 450, 200
  ])
})

it('moves a merged crop below an interior caption for the following table', () => {
  const table = { cropRect: [50, 100, 450, 300] }
  const items = [
    token('A', 60, 120),
    token('1', 180, 120),
    token('B', 60, 180),
    token('2', 180, 180)
  ]
  expect(recoverCaptionBoundaryCrop(table, items, [caption(150)], [])).toEqual([
    50, 164.5, 450, 300
  ])
})

it('ignores rows outside the detector crop when proving an interior boundary', () => {
  const table = { cropRect: [50, 100, 450, 300] }
  const items = [
    token('above-a', 60, 60),
    token('above-b', 180, 60),
    token('below-a', 60, 320),
    token('below-b', 180, 320)
  ]
  expect(recoverCaptionBoundaryCrop(table, items, [caption(150)], [])).toBeUndefined()
})
