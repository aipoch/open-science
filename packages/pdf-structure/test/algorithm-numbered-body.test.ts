import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { findNativeAlgorithmCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-algorithm-native-body.mjs')).href
)

function sample(scale = 0.98): ReturnType<typeof JSON.parse> {
  const rows: [string, number, number][] = [
    ['Algorithm 1 Collect values', 50, 100],
    ['Require: values', 50, 120],
    ['and a bound', 65, 132],
    ['Ensure: total', 50, 144],
    ['1: for value in values do', 50, 160],
    ['2: if value > 0 then', 50, 175],
    ['3: Compute the update:', 50, 190],
    ['total ← total + value', 75, 205],
    ['4: else if value = 0 then', 50, 220],
    ['5: Keep total', 50, 235],
    ['6: else', 50, 250],
    ['7: Skip value', 50, 265],
    ['8: end if', 50, 280],
    ['9: end for', 50, 295],
    ['10: return total', 46, 310],
    ['Independent paragraph.', 50, 360]
  ]
  const items = rows.map(([str, x, y], index) => ({
    str,
    dir: 'ltr',
    width: str.length * 4,
    height: 10,
    transform: [index === 1 ? 10 * scale : 10, 0, 0, 10, x, 800 - y - 10],
    fontName: 'native',
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  const rules = [
    [44, 99, 350, 99],
    [44, 115, 350, 115],
    [44, 335, 350, 335]
  ]
  return {
    page: {
      pageNumber: 1,
      width: 400,
      height: 800,
      rotation: 0,
      invalidGraphicsBounds: 0,
      lines: items.map((i) => ({
        text: i.str,
        x: i.transform[4],
        y: 790 - i.transform[5],
        width: i.width,
        height: 10,
        fontSize: 10
      })),
      graphicsBounds: rules.map((r, i) => ({
        kind: 'path',
        operationIndex: i,
        normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 400))
      }))
    },
    context: {
      rules,
      content: { items, styles: { native: { ascent: 0.8, descent: -0.2 } } },
      viewport: { width: 400, height: 800, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 800] }
    }
  }
}

it.each([0.98, 1, 1.001, 1.02])(
  'protects a complete numbered native frame at horizontal scale %s',
  (scale) => {
    const f = sample(scale),
      before = structuredClone(f)
    const result = findNativeAlgorithmCandidates(f.page, f.context)
    expect(result).toHaveLength(1)
    expect(result[0].nativeBody?.sourceItems).toEqual(
      f.context.content.items.slice(1, -1).map((i: { sourceItem: unknown }) => i.sourceItem)
    )
    expect(result[0].caption.rect).toEqual([50, 102, 50 + f.context.content.items[0].width, 112])
    expect(f).toEqual(before)
  }
)

it.each([
  'closing-rule',
  'divider',
  'ordinal',
  'unclosed',
  'wrong-close',
  'missing-return',
  'else-after-else',
  'unframed-prose',
  'crossing',
  'literal',
  'alias',
  'zero-scale',
  'negative-scale',
  'shear',
  'vertical-height',
  'unknown-ascent'
])('does not protect an existing crop with incomplete %s evidence', (mode) => {
  const f = sample()
  const replace = (index: number, str: string): void => {
    const item = f.context.content.items[index]
    item.str = str
    item.sourceItem.text = str
    item.width = str.length * 4
    f.page.lines[index].text = str
    f.page.lines[index].width = item.width
  }
  if (mode === 'closing-rule') f.context.rules.pop()
  if (mode === 'divider') f.context.rules.splice(1, 1)
  if (mode === 'ordinal') replace(10, '8: Keep total')
  if (mode === 'unclosed') replace(13, '9: Keep total')
  if (mode === 'wrong-close') replace(13, '9: end if')
  if (mode === 'missing-return') replace(14, '10: Keep total')
  if (mode === 'else-after-else') replace(8, '4: else')
  if (mode === 'unframed-prose') replace(7, 'An unrelated paragraph occurs here.')
  if (mode === 'crossing') f.context.content.items[7].width = 500
  if (mode === 'literal') f.context.content.items[7].sourceItem.text = 'Other'
  if (mode === 'alias')
    f.context.content.items[7].sourceSegment = {
      ...f.context.content.items[7].sourceItem,
      start: 0,
      end: 3
    }
  if (mode === 'zero-scale') f.context.content.items[1].transform[0] = 0
  if (mode === 'negative-scale') f.context.content.items[1].transform[0] = -10
  if (mode === 'shear') f.context.content.items[1].transform[1] = 0.1
  if (mode === 'vertical-height') f.context.content.items[1].transform[3] = 9
  if (mode === 'unknown-ascent') delete f.context.content.styles.native.ascent
  expect(
    findNativeAlgorithmCandidates(f.page, f.context).every(
      (a: { nativeBody?: unknown }) => !a.nativeBody
    )
  ).toBe(true)
})
function columnProcedure(): ReturnType<typeof sample> {
  const f = sample()
  f.page.width = 800
  f.context.viewport.width = 800
  for (const g of f.page.graphicsBounds) {
    g.normalizedRect[0] /= 2
    g.normalizedRect[2] /= 2
  }
  f.page.lines.splice(3, 1)
  f.context.content.items.splice(3, 1)
  f.context.content.items.forEach((item: { sourceItem: { index: number } }, index: number) => {
    item.sourceItem.index = index
  })
  return f
}

it('proves a column-width closed procedure with inputs and an explicit return', () => {
  const f = columnProcedure(),
    before = structuredClone(f)
  const result = findNativeAlgorithmCandidates(f.page, f.context)
  expect(result).toHaveLength(1)
  expect(result[0].nativeBody?.sourceItems).toEqual(
    f.context.content.items.slice(1, -1).map((i: { sourceItem: unknown }) => i.sourceItem)
  )
  expect(f).toEqual(before)
})

it.each([
  'unequal-frame',
  'unframed-body',
  'missing-input',
  'second-output',
  'unclosed-loop',
  'numbered-prose'
])('rejects a column-width procedure with %s', (mode) => {
  const f = columnProcedure()
  if (mode === 'unequal-frame') f.context.rules[1][2] -= 30
  if (mode === 'unframed-body') f.context.content.items[6].width = 500
  const replace = (index: number, text: string): void => {
    const item = f.context.content.items[index]
    item.str = text
    item.sourceItem.text = text
    item.width = text.length * 4
    f.page.lines[index].text = text
    f.page.lines[index].width = item.width
  }
  if (mode === 'missing-input') replace(1, 'Ordinary introduction')
  if (mode === 'second-output') {
    replace(2, 'Ensure: total')
    const item = structuredClone(f.context.content.items[2]),
      line = structuredClone(f.page.lines[2])
    item.transform[5] -= 12
    line.y += 12
    f.context.content.items.splice(3, 0, item)
    f.page.lines.splice(3, 0, line)
    f.context.content.items.forEach((i: { sourceItem: { index: number } }, index: number) => {
      i.sourceItem.index = index
    })
  }
  if (mode === 'unclosed-loop') replace(12, '9: Continue computing')
  if (mode === 'numbered-prose') {
    for (let i = 3; i < 13; i++) {
      const number = f.page.lines[i].text.match(/^\d+/)?.[0]
      if (number) replace(i, `${number}: Read the next paragraph`)
    }
  }
  expect(
    findNativeAlgorithmCandidates(f.page, f.context).every(
      (a: { nativeBody?: unknown }) => !a.nativeBody
    )
  ).toBe(true)
})

it.each(['valid', 'source-order', 'literal', 'overlapping-output'])(
  'uses the native first ordinal below a raised script only with complete %s evidence',
  (mode) => {
    const f = sample()
    const replacements: Record<number, string> = {
      4: '1: m ← count(values)',
      5: '2: for value in values do',
      8: '4: Keep total',
      10: '6: Keep total',
      12: '8: Keep total'
    }
    for (const [key, value] of Object.entries(replacements)) {
      const index = Number(key),
        item = f.context.content.items[index]
      item.str = value
      item.sourceItem.text = value
      item.width = value.length * 4
      f.page.lines[index].text = value
      f.page.lines[index].width = item.width
    }
    f.context.content.items[3].transform[5] -= 5.5
    f.page.lines[3].y += 5.5
    const item = {
      str: '(2)',
      dir: 'ltr',
      width: 12,
      height: 6,
      transform: [6, 0, 0, 6, 80, 635],
      fontName: 'native',
      sourceItem: { pageNumber: 1, index: 5, text: '(2)' }
    }
    f.context.content.items.splice(5, 0, item)
    f.context.content.items.forEach((i: { sourceItem: { index: number } }, index: number) => {
      i.sourceItem.index = index
    })
    f.page.lines.splice(5, 0, { text: '(2)', x: 80, y: 159, width: 12, height: 6, fontSize: 6 })
    if (mode === 'source-order') {
      const output = f.context.content.items.splice(3, 1)[0]
      f.context.content.items.splice(5, 0, output)
      f.context.content.items.forEach((i: { sourceItem: { index: number } }, index: number) => {
        i.sourceItem.index = index
      })
    }
    if (mode === 'literal') f.context.content.items[4].sourceItem.text = 'Other ordinal'
    if (mode === 'overlapping-output') {
      f.context.content.items[3].transform[5] -= 10
      f.page.lines[3].y += 10
    }
    const result = findNativeAlgorithmCandidates(f.page, f.context)
    expect(result.some((a: { nativeBody?: unknown }) => !!a.nativeBody)).toBe(mode === 'valid')
  }
)
