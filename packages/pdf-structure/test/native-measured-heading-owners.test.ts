import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { anonymousMeasuredHeadingOwners } = await import(
  pathToFileURL(resolve('test/fixtures/native-measured-heading-owners.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { repairNativeMeasuredHeadingOwners } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-measured-heading-owners.mjs')).href
)
it('owns both measured headings using the independent complete body gutter', () => {
  const f = anonymousMeasuredHeadingOwners(),
    initial = refineTable(
      f.table,
      f.tokens,
      f.captions,
      [],
      f.rules,
      f.runs,
      undefined,
      f.paint,
      f.context
    ),
    r =
      repairNativeMeasuredHeadingOwners(initial, f.tokens, f.captions, f.rules, f.context) ??
      initial
  expect(r.grid[0]).toEqual(['Year', 'Study', 'Focus', 'Main'])
  const header = r.cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column)
  expect(header[0].sourceItems).toBeUndefined()
  expect(header[1].sourceItems).toBeUndefined()
  expect(
    header.slice(0, 2).map((c) => c.sourceSegments.map((s) => [s.index, s.start, s.end]))
  ).toEqual([[[1, 0, 4]], [[1, 5, 10]]])
  expect(r.cropRect).toEqual(initial.cropRect)
  expect(r.cells.filter((c) => c.row > 0)).toEqual(initial.cells.filter((c) => c.row > 0))
  expect(r.issues).toEqual(initial.issues)
  expect(r.reviewCandidate).toEqual(initial.reviewCandidate)
  expect(
    repairNativeMeasuredHeadingOwners(r, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
})

const legacy = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules, f.runs, undefined, f.paint, {
    ...f.context,
    nativeGlyphContext: undefined
  })
const prove = (
  f: ReturnType<typeof JSON.parse>,
  table = legacy(f)
): ReturnType<typeof JSON.parse> =>
  repairNativeMeasuredHeadingOwners(table, f.tokens, f.captions, f.rules, f.context)

it('leaves the ordinary single-TJ program gate unchanged', async () => {
  const f = anonymousMeasuredHeadingOwners(),
    { proveOrdinaryNativeTablePrograms } = await import(
      pathToFileURL(resolve('resources/literature-pdf-native-bounded-text-record-grid.mjs')).href
    )
  expect(proveOrdinaryNativeTablePrograms(f.tokens, f.context, 1)).not.toBe(true)
  expect(prove(f)?.grid[0]).toEqual(['Year', 'Study', 'Focus', 'Main'])
})

it.each([
  'text',
  'index',
  'rect',
  'glyph-rect',
  'missing-token',
  'missing-origin',
  'duplicate-source',
  'body-span',
  'missing-cell'
])('rejects an incomplete or altered existing body owner: %s', (mutation) => {
  const f = anonymousMeasuredHeadingOwners(),
    r = legacy(f),
    cell = r.cells.find((c) => c.row === 1 && c.column === 0)
  if (mutation === 'text') {
    cell.text = '9999'
    r.grid[1][0] = '9999'
  }
  if (mutation === 'index') cell.sourceItems[0] = { ...cell.sourceItems[0], index: 2 }
  if (mutation === 'rect') cell.sourceRects[0][0] += 1
  if (mutation === 'glyph-rect') cell.sourceTokens[0].rect[0] += 1
  if (mutation === 'missing-token') cell.sourceTokens = []
  if (mutation === 'missing-origin') cell.sourceItems = []
  if (mutation === 'duplicate-source')
    f.tokens.push({ ...f.tokens.find((t) => t.sourceItem.index === cell.sourceItems[0].index) })
  if (mutation === 'body-span') cell.rowSpan = 2
  if (mutation === 'missing-cell') r.cells.splice(r.cells.indexOf(cell), 1)
  expect(prove(f, r)).toBeUndefined()
})

it.each(['width', 'transform', 'style', 'literal'])(
  'requires the current original source carrier: %s',
  (mutation) => {
    const f = anonymousMeasuredHeadingOwners(),
      r = legacy(f),
      source = structuredClone(f.context.sourceContent)
    f.context.sourceContent = source
    f.context.content = source
    if (mutation === 'width') source.items[1].width += 1
    if (mutation === 'transform') source.items[1].transform[4] += 1
    if (mutation === 'style') source.styles.F.ascent = 0.8
    if (mutation === 'literal') source.items[1].str = 'Year Other'
    expect(prove(f, r)).toBeUndefined()
  }
)

it.each(['missing', 'ambiguous', 'false-caption'])(
  'requires one complete adjacent original caption: %s',
  (mutation) => {
    const f = anonymousMeasuredHeadingOwners(),
      r = legacy(f)
    if (mutation === 'missing') f.captions = []
    if (mutation === 'ambiguous') f.captions.push(structuredClone(f.captions[0]))
    if (mutation === 'false-caption') f.captions[0].lines = ['Table 1: Other']
    expect(prove(f, r)).toBeUndefined()
  }
)

it('declines two independently possible header gap cuts in the same empty body gutter', () => {
  const f = anonymousMeasuredHeadingOwners({ header: 'Year A Study', studyX: 55 })
  expect(prove(f)).toBeUndefined()
})

it.each(['native', 'declared', 'both'])(
  'requires all three physical fences with exact declaration: %s',
  (witness) => {
    for (const rule of [0, 1, 2]) {
      const f = anonymousMeasuredHeadingOwners(),
        r = legacy(f),
        positions = f.context.operators.fnArray.flatMap((op, n) =>
          op === OPS.constructPath ? [n] : []
        ),
        at = positions[rule]
      if (witness !== 'native') f.rules.splice(rule, 1)
      if (witness !== 'declared') {
        f.context.operators.fnArray.splice(at, 1)
        f.context.operators.argsArray.splice(at, 1)
        f.context.sourcePage.graphicsBounds.splice(rule, 1)
      }
      expect(prove(f, r)).toBeUndefined()
    }
  }
)

it.each(
  ['top', 'bottom', 'both'].flatMap((boundary) =>
    ['native', 'declared', 'both'].map((witness) => ({ boundary, witness }))
  )
)(
  'declines an extra foreign stroke crossing $boundary with $witness evidence',
  ({ boundary, witness }) => {
    const f = anonymousMeasuredHeadingOwners(),
      r = legacy(f),
      top = boundary === 'bottom' ? 90 : 20,
      bottom = boundary === 'top' ? 90 : 170,
      line = [27 * 1.5, top * 1.5, 27 * 1.5, bottom * 1.5]
    if (witness !== 'native') f.rules.push(line)
    if (witness !== 'declared') {
      const o = f.context.operators,
        at = o.fnArray.length
      o.fnArray.push(OPS.constructPath)
      o.argsArray.push([
        OPS.stroke,
        [[0, 27, 220 - top, 1, 27, 220 - bottom]],
        [27, 220 - bottom, 27, 220 - top]
      ])
      f.context.sourcePage.graphicsBounds.push({
        kind: 'path',
        operationIndex: at,
        normalizedRect: [26.8 / 320, top / 220, 27.2 / 320, bottom / 220]
      })
    }
    expect(prove(f, r)).toBeUndefined()
  }
)

it('preserves unrelated warnings and all inputs', () => {
  const f = anonymousMeasuredHeadingOwners(),
    r = legacy(f)
  r.issues = ['ambiguous-cell-assignment']
  r.reviewCandidate = false
  const before = JSON.stringify({ f, r }),
    p = prove(f, r)
  expect(p?.grid[0]).toEqual(['Year', 'Study', 'Focus', 'Main'])
  expect(p.issues).toEqual(r.issues)
  expect(p.reviewCandidate).toBe(false)
  expect(JSON.stringify({ f, r })).toBe(before)
})

it.each(['group', 'transparent', 'white', 'extra-header-source'])(
  'keeps unsupported native evidence outside the purpose: %s',
  (mutation) => {
    const f = anonymousMeasuredHeadingOwners(),
      r = legacy(f),
      o = f.context.operators
    if (mutation === 'group') {
      o.fnArray.push(OPS.beginGroup, OPS.endGroup)
      o.argsArray.push(
        [{ matrix: null, bbox: [0, 0, 10, 10], smask: null, isolated: false, knockout: false }],
        null
      )
    }
    if (mutation === 'transparent') {
      o.fnArray.unshift(OPS.setGState)
      o.argsArray.unshift([[['ca', 0.5]]])
    }
    if (mutation === 'white') o.argsArray[o.fnArray.indexOf(OPS.setFillRGBColor)] = ['#ffffff']
    if (mutation === 'extra-header-source')
      r.cells.find((c) => c.row === 0 && c.column === 0).sourceItems = [f.tokens[1].sourceItem]
    expect(prove(f, r)).toBeUndefined()
  }
)
