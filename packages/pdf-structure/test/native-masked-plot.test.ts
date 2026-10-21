import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativeMaskedPlotBounds } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-masked-plot.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- infer anonymous geometry
function fixture() {
  const frame = [150, 100, 450, 340]
  const masks = [
    ...[180, 280, 380].map((x) => [x - 4, 344, x + 4, 354]),
    ...[130, 230, 330].map((y) => [136, y - 5, 146, y + 5]),
    [230, 70, 370, 88],
    [110, 150, 125, 290],
    [250, 365, 350, 380]
  ]
  const fnArray: number[] = [],
    argsArray: unknown[][] = []
  for (const r of masks) {
    fnArray.push(OPS.save, OPS.transform, OPS.paintImageMaskXObject, OPS.restore)
    argsArray.push(
      [],
      [r[2] - r[0], 0, 0, r[3] - r[1], r[0], r[1]],
      [{ width: 8, height: 8, data: new Uint8Array(8) }],
      []
    )
  }
  const page = {
    width: 600,
    height: 800,
    lines: [] as { x: number; y: number; width: number; height: number }[]
  }
  const context = {
    viewport: { scale: 1, transform: [1, 0, 0, 1, 0, 0] },
    operators: { fnArray, argsArray }
  }
  const rules = [
    ...[180, 280, 380].map((x) => [x, 334, x, 340]),
    ...[130, 230, 330].map((y) => [150, y, 156, y]),
    ...[180, 280, 380].map((x) => [x, 100, x, 106])
  ]
  const run = (): number[] | undefined =>
    nativeMaskedPlotBounds(
      page,
      { rect: frame },
      [{ rect: [90, 410, 510, 430] }],
      [],
      [frame],
      rules,
      context
    )
  const addMask = (r: number[]): void => {
    fnArray.push(OPS.save, OPS.transform, OPS.paintImageMaskXObject, OPS.restore)
    argsArray.push(
      [],
      [r[2] - r[0], 0, 0, r[3] - r[1], r[0], r[1]],
      [{ width: 8, height: 8, data: new Uint8Array(8) }],
      []
    )
  }
  return { page, context, rules, run, addMask }
}

it('keeps the painted mask envelope around a closed plot with independently ticked axes', () => {
  expect(fixture().run()).toEqual([110, 70, 450, 380])
})
it('does not absorb prose inside a proposed mask extension', () => {
  const input = fixture()
  input.page.lines.push({ x: 230, y: 70, width: 140, height: 18 })
  expect(input.run()).toBeUndefined()
})
it('requires both independently ticked axes', () => {
  const input = fixture()
  input.rules.splice(3)
  expect(input.run()).toBeUndefined()
})
it.each([OPS.clip, OPS.beginGroup, OPS.beginAnnotation])(
  'does not infer a visible envelope through unknown graphics state %s',
  (operation) => {
    const input = fixture()
    input.context.operators.fnArray.unshift(operation)
    input.context.operators.argsArray.unshift([])
    expect(input.run()).toBeUndefined()
  }
)
it('rejects an unbalanced graphics state', () => {
  const input = fixture()
  input.context.operators.fnArray.pop()
  input.context.operators.argsArray.pop()
  expect(input.run()).toBeUndefined()
})

it.each([
  [490, 190, 510, 220],
  [80, 50, 140, 65]
])('does not absorb an unproved neighboring mask %j', (...rect) => {
  const input = fixture()
  input.addMask(rect)
  expect(input.run()).toBeUndefined()
})

it('keeps a centered axis title whole even when it is wider than the plot', () => {
  const input = fixture()
  input.addMask([65, 365, 535, 380])
  expect(input.run()).toEqual([65, 70, 535, 380])
})
