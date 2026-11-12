import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousSparseCitedHierarchy } = await import(
  pathToFileURL(resolve('test/fixtures/native-sparse-cited-hierarchy.mjs')).href
)
const { recoverNativeSparseCitedHierarchyGrid: recover } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-sparse-cited-hierarchy.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { nativeWholeCellInkPacket, nativePageTextPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { matchNativeFigureRenderContext } = await import(
  pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const prove = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  recover(f.table, f.items, f.captions, f.rules, f.context)

it.each([2, 4])(
  'owns complete actual PDF citation records inside %i native category bands',
  async (bands) => {
    const f = await anonymousSparseCitedHierarchy({ bands })
    try {
      const before = JSON.stringify({
          table: f.table,
          items: f.items,
          captions: f.captions,
          rules: f.rules
        }),
        p = prove(f)
      expect(p).toBeDefined()
      expect(p.rows).toHaveLength(bands * 2 + 1)
      expect(p.columns).toHaveLength(4)
      expect(p.spans).toEqual(f.expected.categorySpans)
      expect(p.ownedTokens.size).toBe(f.expected.originalSources.length)
      expect(
        JSON.stringify({ table: f.table, items: f.items, captions: f.captions, rules: f.rules })
      ).toBe(before)
    } finally {
      await f.cleanup()
    }
  }
)

it('carries the complete native plan through actual refinement of a coarse detector grid', async () => {
  const f = await anonymousSparseCitedHierarchy()
  try {
    const r = refineTable(
      f.table,
      f.items,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      undefined,
      f.context
    )
    expect(r.grid).toHaveLength(5)
    expect(r.grid[0]).toHaveLength(4)
    expect(r.unassigned).toEqual([])
    expect(r.cells.filter((c) => c.column === 0 && c.row > 0).map((c) => c.rowSpan)).toEqual([2, 2])
    expect(
      r.cells
        .flatMap((c) => c.sourceItems ?? [])
        .map((s) => s.index)
        .sort((a, b) => a - b)
    ).toEqual(f.expected.originalSources.map((s) => s.index))
  } finally {
    await f.cleanup()
  }
})

it('leaves ordinary whole-cell admission strict and never normalizes a claimed micro sign', async () => {
  for (const mode of ['', 'claimed-mu']) {
    const f = await anonymousSparseCitedHierarchy({ mode })
    try {
      const n = f.context.nativeGlyphContext,
        b = matchNativeFigureRenderContext(
          n,
          1,
          f.context.sourceContent,
          n.viewport,
          f.context.sourcePage.graphicsBounds,
          n.sourceSha256
        ),
        c = { ...b, pageNumber: 1, sourceSha256: n.sourceSha256 },
        tokens = c.content.items
          .filter((i) => i.str?.trim())
          .map((i) => tableTextToken(i, c.viewport, 0)),
        ids = new Set(f.expected.originalSources.map((i) => i.index)),
        fonts = f.items.filter((i) => ids.has(i.sourceItem.index))
      expect(
        nativeWholeCellInkPacket(f.context.sourcePage, tokens, c, {
          text: fonts.map((i) => i.text).join(''),
          sourceItems: fonts.map((i) => i.sourceItem),
          sourceRects: fonts.map((i) => i.rect.map((x) => x / 1.5))
        })
      ).toBeUndefined()
      const p = nativePageTextPacketInventory(f.context.sourcePage, tokens, c, false, ids, true)
      if (mode) {
        expect(p).toBeUndefined()
        expect(prove(f)).toBeUndefined()
      } else {
        expect(p).toBeDefined()
        const foreign = p.records.filter((r) => r.foreignSourceNormalized)
        expect(foreign).toHaveLength(1)
        expect(foreign[0].r.str).toBe('μ')
        expect(foreign[0].part.map((z) => z.c).join('')).toBe('µ')
        expect(ids.has(foreign[0].index)).toBe(false)
      }
    } finally {
      await f.cleanup()
    }
  }
})

it.each([
  'missing-fence',
  'citation',
  'source-cycle',
  'cross-fence',
  'foreign-paint',
  'foreign-padding-paint',
  'claimed-mu',
  'quantitative-parent'
])('declines an incomplete native proof: %s', async (mode) => {
  const f = await anonymousSparseCitedHierarchy({ mode })
  try {
    expect(prove(f)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each([
  'missing',
  'duplicate',
  'literal',
  'rect',
  'caption',
  'ambiguous-caption',
  'caption-literal',
  'extra-rule',
  'crossing-rule',
  'current-carrier'
])('requires all original fonts, captions and native fences: %s', async (mutation) => {
  const f = await anonymousSparseCitedHierarchy()
  try {
    const token = f.items.find((i) => i.text === 'LeafA')
    if (mutation === 'missing') f.items.splice(f.items.indexOf(token), 1)
    if (mutation === 'duplicate') f.items.push({ ...token })
    if (mutation === 'literal') token.sourceItem = { ...token.sourceItem, text: 'Other' }
    if (mutation === 'rect') token.rect = [token.rect[0] + 1, ...token.rect.slice(1)]
    if (mutation === 'caption') f.captions = []
    if (mutation === 'ambiguous-caption') f.captions.push({ ...f.captions[0] })
    if (mutation === 'caption-literal') f.captions[0].lines = ['Table 1: Other']
    if (mutation === 'extra-rule') f.rules.push([60, 250, 390, 250])
    if (mutation === 'crossing-rule') f.rules.push([65, 100, 65, 400])
    if (mutation === 'current-carrier') {
      const content = structuredClone(f.context.sourceContent)
      content.items[token.sourceItem.index].width += 1
      f.context.sourceContent = content
      f.context.content = content
    }
    expect(prove(f)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})
