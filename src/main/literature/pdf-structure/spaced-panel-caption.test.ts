import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateTableCaptions, associateGraphicalTables } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    'src/main/literature/pdf-structure/fixtures/source-grids/double-spaced-paired-panel-caption-with-measurement-tail.jsonl'
  )
const associate = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  associateTableCaptions(f.page, f.tables, f.candidates)[0].caption

it('retains the native panel caption through the graphical-table extraction path', () => {
  const f = load(),
    tables = associateGraphicalTables(f.graphicPage, f.candidates)
  expect(tables).toHaveLength(1)
  expect(tables[0].caption.lines).toHaveLength(3)
  expect(tables[0].rect).toEqual(f.tables[0].rect)
})

it.each([0.7, 1, 1.8])(
  'retains a complete double-spaced paired-panel caption at scale %s',
  (scale) => {
    const f = load()
    for (const l of f.page.lines)
      for (const k of ['x', 'y', 'width', 'height', 'fontSize']) l[k] *= scale
    f.page.width *= scale
    f.page.height *= scale
    for (const t of [...f.tables, ...f.candidates]) t.rect = t.rect.map((v: number) => v * scale)
    const c = associate(f)
    expect(c.lines).toHaveLength(3)
    expect(c.lines[1]).toContain('7.5 mL of blood in separate runs')
    expect(c.lines[2]).toBe('CTC count means ≥1 CTC/7.5 mL.')
    expect(c.rect[3]).toBeCloseTo(331.42 * scale)
  }
)

it.each([
  'missing-panel',
  'different-native-panels',
  'duplicate-native-panel',
  'outside-native-panel',
  'missing-first-reference',
  'out-of-order-reference',
  'extra-reference',
  'closed-middle',
  'non-acronym-tail',
  'unclosed-tail',
  'different-leading',
  'different-font',
  'different-indent',
  'extra-continuation'
])('keeps the accepted caption when continuation evidence is ambiguous: %s', (change) => {
  const f = load(),
    native = f.page.lines[0],
    middle = f.page.lines[2],
    tail = f.page.lines[3]
  if (change === 'missing-panel') native.text = 'BASELINE AFTER CYCLE 1'
  if (change === 'different-native-panels') native.text = native.text.replace('B.', 'C.')
  if (change === 'duplicate-native-panel') f.page.lines.push({ ...native, y: native.y + 13 })
  if (change === 'outside-native-panel') native.y = f.tables[0].rect[1] - 20
  if (change === 'missing-first-reference') {
    f.candidates[0].lines[0] = f.candidates[0].lines[0].replace('(A.)', 'baseline')
    f.page.lines[1].text = f.candidates[0].lines[0]
  }
  if (change === 'out-of-order-reference') middle.text = middle.text.replace('(B.)', '(C.)')
  if (change === 'extra-reference') middle.text += ' (C.)'
  if (change === 'closed-middle') middle.text += '.'
  if (change === 'non-acronym-tail') tail.text = 'Other material at the same leading.'
  if (change === 'unclosed-tail') tail.text = tail.text.slice(0, -1)
  if (change === 'different-leading') tail.y += 4
  if (change === 'different-font') tail.fontSize += 2
  if (change === 'different-indent') tail.x += 8
  if (change === 'extra-continuation') f.page.lines.push({ ...tail, y: tail.y + 8 })
  expect(associate(f).lines).toHaveLength(1)
})
