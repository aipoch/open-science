import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousScriptedArray } = await import(
  pathToFileURL(resolve('test/fixtures/open-axis-scripted-array.mjs')).href
)
const { nativePageTextPacketInventory, nativeWholeCellInkPacket, nativeTypedPlotPacketInventory } =
  await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
  )

// Reuse the existing plot: three ticks and one exterior caption glyph become
// Type3 programs; every other original font, glyph, rule and clip is retained.
const typedPlot = (): ReturnType<typeof JSON.parse> => {
  const f = anonymousScriptedArray(),
    c = f.args[6],
    o = c.operators
  const glyphs = ['0', 'C'].map((unicode) => ({
    operatorListId: unicode,
    unicode,
    width: 500,
    kind: 'filled-path',
    bounds: [0, -100, 500, 700],
    clip: [0, -100, 500, 700],
    paint: OPS.fill,
    occurrences: [] as { operationIndex: number; glyphIndex: number }[]
  }))
  for (let i = 0; i < o.fnArray.length; i++)
    if (o.fnArray[i] === OPS.showText) {
      for (const [index, g] of o.argsArray[i][0].entries()) {
        const program = glyphs.find((p) => p.unicode === g?.unicode)
        if (!program) continue
        g.fontChar = ''
        g.operatorListId = program.operatorListId
        o.argsArray[i - 2][0] = 'T'
        program.occurrences.push({ operationIndex: i, glyphIndex: index })
      }
    }
  for (const r of c.content.items) if (glyphs.some((p) => p.unicode === r.str)) r.fontName = 'T'
  c.content.styles.T = { ...c.content.styles.F }
  c.partialFontGlyphBounds = c.glyphBounds.map((font: ReturnType<typeof JSON.parse>) => ({
    ...font,
    glyphs: font.glyphs.filter(
      (g: { fontChar: string }) => !glyphs.some((p) => p.unicode === g.fontChar)
    )
  }))
  delete c.glyphBounds
  c.type3GlyphPrograms = [
    {
      fontName: 'T',
      fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      sourceIndices: c.content.items.flatMap((r: { fontName: string }, i: number) =>
        r.fontName === 'T' ? [i] : []
      ),
      glyphs
    }
  ]
  return f
}
const packet = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  nativeTypedPlotPacketInventory?.(
    f.args[0],
    f.figure,
    f.args[1],
    f.args[2],
    f.args[3],
    f.args[5],
    f.args[6]
  )

it('binds every ordinary and Type3 glyph in the fixed plot packet, including exterior text', () => {
  const f = typedPlot(),
    before = JSON.stringify(f),
    proof = packet(f)
  expect(proof).toBeDefined()
  expect(proof.records).toHaveLength(f.args[6].content.items.length)
  expect(proof.records.find((r: { r: { str: string } }) => r.r.str === 'C')).toBeDefined()
  expect(JSON.stringify(f)).toBe(before)
})

it.each([
  'missing foreign program',
  'duplicate occurrence',
  'missing source index',
  'matrix shear',
  'program clip mismatch',
  'missing ordinary outline',
  'transparent parent'
])('refuses an incomplete Type3 plot packet with %s', (mode) => {
  const f = typedPlot(),
    c = f.args[6],
    font = c.type3GlyphPrograms[0]
  if (mode === 'missing foreign program') font.glyphs.pop()
  if (mode === 'duplicate occurrence')
    font.glyphs[0].occurrences.push(font.glyphs[0].occurrences[0])
  if (mode === 'missing source index') font.sourceIndices.pop()
  if (mode === 'matrix shear') font.fontMatrix[1] = 0.1
  if (mode === 'program clip mismatch') font.glyphs[0].clip[2]--
  if (mode === 'missing ordinary outline') c.partialFontGlyphBounds[0].glyphs.pop()
  if (mode === 'transparent parent') {
    const i = font.glyphs[0].occurrences[0].operationIndex - 3
    c.operators.fnArray.splice(i, 0, OPS.setGState)
    c.operators.argsArray.splice(i, 0, [[['ca', 1]]])
    for (const p of font.glyphs)
      for (const o of p.occurrences) if (o.operationIndex >= i) o.operationIndex++
    expect(packet(f), 'the same parent operation remains valid when opaque').toBeDefined()
    c.operators.argsArray[i][0][0][1] = 0.5
  }
  expect(packet(f)).toBeUndefined()
})

it('keeps the original page and whole-cell packet contracts unavailable for Type3 glyphs', () => {
  const f = typedPlot(),
    c = f.args[6],
    ordinary = anonymousScriptedArray()
  // Qualify the fixed-cell control independently of its stricter empty-space
  // default: both fixtures bind their existing zero-outline spaces to the font.
  for (const context of [c, ordinary.args[6]])
    for (let i = 0; i < context.operators.fnArray.length; i++)
      if (context.operators.fnArray[i] === OPS.showText)
        for (const g of context.operators.argsArray[i][0]) if (g?.unicode === ' ') g.isInFont = true
  expect(nativePageTextPacketInventory(f.args[0], f.args[5], c, true)).toBeUndefined()
  const t = f.args[5][0]
  expect(
    nativeWholeCellInkPacket(ordinary.args[0], ordinary.args[5], ordinary.args[6], {
      text: t.text,
      sourceItems: [t.sourceItem],
      sourceRects: [t.rect]
    })
  ).toBeDefined()
  expect(
    nativeWholeCellInkPacket(f.args[0], f.args[5], c, {
      text: t.text,
      sourceItems: [t.sourceItem],
      sourceRects: [t.rect]
    })
  ).toBeUndefined()
})
