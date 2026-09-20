import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { startsDetachedTextColumn } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const item = (
  str: string,
  x: number,
  width: number,
  height = 8,
  y = 300
): { str: string; width: number; height: number; transform: number[] } => ({
  str,
  width,
  height,
  transform: [height, 0, 0, height, x, y]
})
it('separates adjacent columns despite near-identical stream baselines', () => {
  expect(
    startsDetachedTextColumn([item('caption', 45, 216)], item('body', 285, 216, 10, 301.75))
  ).toBe(true)
  expect(
    startsDetachedTextColumn([item('body', 285, 216, 10)], item('caption', 45, 216, 8, 298.25))
  ).toBe(true)
})
it('ignores synthetic spacing when finding the preceding painted text', () => {
  expect(
    startsDetachedTextColumn(
      [item('caption', 45, 216), item(' ', 261, 24, 0)],
      item('body', 285, 216, 10)
    )
  ).toBe(true)
})
it('preserves words, scripts, overlapping glyphs, whitespace and rotated text', () => {
  const before = item('Fig. 3.', 45, 25)
  for (const after of [
    item('Caption', 73, 80),
    item('2', 69, 4, 5),
    item(' ', 95, 0, 0),
    item('same-size column', 120, 80),
    { ...item('axis', 110, 30), transform: [0, 8, -8, 0, 110, 300] }
  ])
    expect(startsDetachedTextColumn([before], after)).toBe(false)
})
