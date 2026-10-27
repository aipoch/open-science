import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths'

const { signedNativeRecords } = await import(
  pathToFileURL(resolve('test/fixtures/signed-native-records.mjs')).href
)
const { recoverCaptionedRuledTables } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
type Fixture = ReturnType<typeof JSON.parse>
const recover = (f: Fixture): Fixture[] =>
  recoverCaptionedRuledTables(f.items, f.rules, f.captions, 1, [], [], f.paint, f.evidence).filter(
    (t: Fixture) => t.id.startsWith('p1-native-compact-table-')
  )

it('recovers complete signed records with independent explicit symbol and numeric fonts', () => {
  const f = signedNativeRecords(),
    before = JSON.stringify(f),
    tables = recover(f)
  expect(tables).toHaveLength(1)
  expect(tables[0].structure.objects.filter((o: Fixture) => o.label === 'table row')).toHaveLength(
    7
  )
  expect(
    tables[0].structure.objects.filter((o: Fixture) => o.label === 'table column')
  ).toHaveLength(8)
  expect(JSON.stringify(f)).toBe(before)
})

it.each([
  'renderer',
  'symbol font',
  'glyph',
  'source order',
  'sign scale',
  'missing leaf',
  'crossing header',
  'closing paint',
  'source alias',
  'intervening caption',
  'unsigned',
  'missing value',
  'uncertainty lane',
  'unclaimed ink'
])('declines incomplete signed-source proof: %s', (mode) => {
  const f = signedNativeRecords(mode),
    c = f.evidence.context,
    sign = f.items.find((t: Fixture) => t.text === '−')
  if (mode === 'renderer') delete f.evidence
  if (mode === 'symbol font') delete c.content.styles.S
  if (mode === 'glyph') c.glyphBounds.find((g: Fixture) => g.fontName === 'S').glyphs = []
  if (mode === 'source order') sign.sourceItem.index += 1000
  if (mode === 'sign scale') c.content.items[sign.sourceItem.index].transform[0] += 1
  if (mode === 'missing leaf') f.items.splice(3, 2)
  if (mode === 'crossing header') f.items[3].rect[0] -= 90
  if (mode === 'closing paint') f.paint.delete(f.rules[2].join(','))
  if (mode === 'source alias') f.items.push({ ...f.items[0], rect: [610, 57, 650, 72] })
  if (mode === 'intervening caption')
    f.captions.push({ page: 1, lines: ['Table 2: Independent table'], rect: [0, 160, 600, 175] })
  expect(recover(f)).toEqual([])
})
