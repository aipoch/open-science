import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths'

const { segmentedScientificFixture } = await import(
  pathToFileURL(resolve('test/fixtures/native-segmented-scientific-records.mjs')).href
)
const { recoverNativeSegmentedScientificGrid } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-lined-record-grid.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
type Fixture = ReturnType<typeof JSON.parse>

it('retains seven native scientific fields without moving or splitting whole sources', async () => {
  const f = await segmentedScientificFixture()
  try {
    const result = refineTable(
      f.table,
      f.tokens,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      f.paint,
      f.context,
      f.witness
    )
    expect(result.grid).toHaveLength(4)
    expect(result.grid).toEqual(f.expected)
    expect(result.unassigned).toEqual([])
    expect(result.cropRect).toEqual(f.table.cropRect)
    expect(
      result.cells.every(
        (cell: Fixture) => cell.rowSpan === 1 && cell.colSpan === 1 && !cell.sourceSegments
      )
    ).toBe(true)
    const [left, top, right, bottom] = f.table.cropRect
    const native = f.tokens.filter(
      (t: Fixture) =>
        t.rect[0] >= left && t.rect[1] >= top && t.rect[2] <= right && t.rect[3] <= bottom
    )
    const expected = native.map((t: Fixture) => ({ source: t.sourceItem, rect: t.rect }))
    const actual = result.cells.flatMap((cell: Fixture) =>
      (cell.sourceItems ?? []).map((source: Fixture, i: number) => ({
        source,
        rect: cell.sourceRects[i]
      }))
    )
    const byIndex = (a: Fixture, b: Fixture): number => a.source.index - b.source.index
    expect(actual.sort(byIndex)).toEqual(expected.sort(byIndex))
    expect(new Set(actual.map((t: Fixture) => t.source.index)).size).toBe(actual.length)
  } finally {
    await f.dispose()
  }
})

it.each(['base', 'caption-padding'])(
  'proves fenced header packets while preserving preview padding: %s',
  async (mode) => {
    const f = await segmentedScientificFixture(mode)
    try {
      const plan = recoverNativeSegmentedScientificGrid(
        f.table,
        f.tokens,
        f.captions,
        f.rules,
        f.context
      )
      expect(plan?.columns).toHaveLength(7)
      expect(plan?.rows).toHaveLength(4)
      expect(plan?.headerRows).toEqual([0])
      expect(plan?.cropRect).toEqual(f.table.cropRect)
    } finally {
      await f.dispose()
    }
  }
)

it.each([
  'caption-crossing',
  'missing-header',
  'tall-header',
  'unequal-bands',
  'foreign-edge-path',
  'foreign-zero-edge',
  'foreign-zero-gutter',
  'model-span',
  'preexisting-issue',
  'external-operators',
  'external-source',
  'work-size',
  'missing-context',
  'getter-member',
  'added-member-during-proof',
  'replaced-member-during-proof',
  'white-frame',
  'gray-frame',
  'cmyk-frame',
  'white-text',
  'missing-divider'
])('refuses scientific fields without complete unchanged native evidence: %s', async (mode) => {
  const f = await segmentedScientificFixture(mode)
  let getterCalls = 0
  try {
    const context = f.context,
      c = context.nativeGlyphContext
    let input = context
    if (mode === 'model-span')
      f.table.structure.objects.push({
        label: 'table spanning cell',
        score: 1,
        rect: [0, 0, 100, 100]
      })
    if (mode === 'preexisting-issue') f.table.issues = ['native-table-structure-ambiguous']
    if (mode === 'external-operators') {
      context.operators = structuredClone(context.operators)
      context.operators.argsArray[context.operators.fnArray.indexOf(OPS.setFont)][1] += 0.000001
    }
    if (mode === 'external-source') {
      context.sourceContent = structuredClone(context.sourceContent)
      context.content = context.sourceContent
      context.sourceContent.items.find((r: Fixture) => r.str?.trim()).width += 0.000001
    }
    if (mode === 'work-size') context.viewport.width += 0.000001
    if (mode === 'missing-context') input = undefined
    if (mode === 'getter-member')
      Object.defineProperty(c, 'unexpected', {
        get() {
          getterCalls++
          return true
        },
        configurable: true
      })
    if (mode === 'added-member-during-proof' || mode === 'replaced-member-during-proof') {
      const convert = context.viewport.convertToViewportPoint.bind(context.viewport)
      let changed = false
      context.viewport.convertToViewportPoint = (...args: number[]): number[] => {
        if (!changed) {
          changed = true
          if (mode === 'added-member-during-proof') c.unexpected = true
          else c.content = { ...c.content }
        }
        return convert(...args)
      }
    }
    expect(
      recoverNativeSegmentedScientificGrid(f.table, f.tokens, f.captions, f.rules, input)
    ).toBeUndefined()
    expect(getterCalls).toBe(0)
  } finally {
    await f.dispose()
  }
})
