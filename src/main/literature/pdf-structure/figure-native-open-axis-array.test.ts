import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { nativeOpenAxisArray } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-open-axis-array.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/repeated-open-axes-with-isolated-native-labels.jsonl'
    )
  )
it('recovers all populated open axes and the native marker legend', () => {
  const f = input()
  const result = associateFigures(f.page, f.captions, [], f.rules)
  expect(result[0].rect).toBeDefined()
  expect(result[0].rect[1]).toBeLessThan(220)
  expect(result[0].rect[3]).toBeGreaterThanOrEqual(522)
})
it.each(['missing-axis', 'foreign-prose', 'competing-caption', 'missing-ink', 'foreign-table'])(
  'rejects incomplete native array proof: %s',
  (reason) => {
    const f = input()
    if (reason === 'missing-axis') f.rules = f.rules.filter((r: number[]) => r[0] !== r[2])
    if (reason === 'foreign-prose')
      f.page.lines.push({
        text: 'Independent sentence. '.repeat(5),
        x: 110,
        y: 235,
        width: 400,
        height: 10,
        fontSize: 10
      })
    if (reason === 'competing-caption')
      f.captions.push({ page: 1, lines: ['Figure 2: Another panel.'], rect: [72, 510, 520, 524] })
    if (reason === 'missing-ink') f.page.graphicsBounds = []
    expect(
      nativeOpenAxisArray(
        f.page,
        f.captions,
        reason === 'foreign-table' ? [[110, 240, 180, 260]] : [],
        f.rules
      )
    ).toBeUndefined()
  }
)

it('preserves the complete native border of an annotation predominantly inside one owned face', () => {
  const f = input()
  f.page.graphicsBounds.push({
    kind: 'path',
    normalizedRect: [
      483.66175 / f.page.width,
      220.3383984375 / f.page.height,
      525.51709375 / f.page.width,
      249.93609375 / f.page.height
    ]
  })
  expect(nativeOpenAxisArray(f.page, f.captions, [], f.rules).rect[2]).toBeGreaterThanOrEqual(
    525.51709375
  )
})

it('declines replacement when an external native raster legend is not owned by an axis face', () => {
  const f = input(),
    r = nativeOpenAxisArray(f.page, f.captions, [], f.rules).rect
  f.page.graphicsBounds.push({
    kind: 'image',
    normalizedRect: [
      r[0] / f.page.width,
      (r[3] + 2) / f.page.height,
      (r[0] + 60) / f.page.width,
      (r[3] + 6) / f.page.height
    ]
  })
  expect(nativeOpenAxisArray(f.page, f.captions, [], f.rules)).toBeUndefined()
})
it('declines replacement when repeated native top titles would be dropped', () => {
  const f = input()
  const axes = f.rules.filter((r: number[]) => r[0] === r[2] && r[3] - r[1] >= 35)
  const y = Math.min(...axes.map((r: number[]) => r[1]))
  for (const r of axes.filter((r: number[]) => Math.abs(r[1] - y) < 0.05))
    f.page.lines.push({
      text: 'Panel title',
      x: r[0] + 10,
      y: y - 16,
      width: 50,
      height: 14,
      fontSize: 14
    })
  expect(nativeOpenAxisArray(f.page, f.captions, [], f.rules)).toBeUndefined()
})
