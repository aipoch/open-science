import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const { scientificOrderFixture, addRemoteScientificImage } = await import(
  pathToFileURL(resolve('test/fixtures/native-scientific-order.mjs')).href
)
const { reviewFinalNativeTableSources: review } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)
type Fixture = ReturnType<typeof JSON.parse>
const check = (f: Fixture): ReturnType<typeof JSON.parse> =>
  review(f.table, f.tokens, f.rules, [], f.context)

it('preserves native scientific sources and suspends a serialized exponent before its base', () => {
  for (const remoteImage of [false, true]) {
    const f = scientificOrderFixture()
    if (remoteImage) addRemoteScientificImage(f)
    const before = JSON.stringify(f),
      result = check(f)
    assert(result.issues.includes('native-table-structure-ambiguous'))
    assert.deepEqual(result.unreliableMathSourceItems, f.target.sourceItems)
    for (const name of ['cells', 'grid', 'cropRect', 'thumbnail', 'notes'])
      assert.equal(result[name], f.table[name])
    assert.equal(JSON.stringify(f), before)
  }
})

const controls: Record<string, (f: Fixture) => void> = {
  'native serialization': (f) => {
    f.target.sourceTokens = f.runs.map((t: Fixture) => ({
      text: t.text,
      rect: t.rect,
      baseline: t.baseline,
      height: t.height
    }))
    f.target.text = f.runs.map((t: Fixture) => t.text).join(' ')
  },
  'missing native snapshot': (f) => delete f.context.nativeGlyphContext,
  'different document': (f) => (f.context.sourceSha256 = 'b'.repeat(64)),
  'duplicate cell owner': (f) => f.cells.push({ ...f.target }),
  'duplicate origin carrier': (f) => f.tokens.push({ ...f.runs[0] }),
  'partial source claim': (f) =>
    (f.target.sourceSegments = [{ ...f.target.sourceItems[0], start: 0, end: 1 }]),
  'missing serialized token': (f) => f.target.sourceTokens.pop(),
  'missing font metric': (f) => delete f.runs[0].fontAscent,
  'missing native metric': (f) => delete f.context.sourceContent.styles.F.ascent,
  'changed native literal': (f) => (f.context.sourceContent.items[1].str = 'Other'),
  'different operator stream': (f) => (f.context.operators.argsArray[0] = ['#ff0000']),
  'different annotation': (f) => (f.target.text = f.target.text.replace('−', '+'))
}
for (const [name, mutate] of Object.entries(controls))
  it('declines scientific ownership with ' + name, () => {
    const f = scientificOrderFixture()
    mutate(f)
    assert.equal(check(f).unreliableMathSourceItems, undefined)
  })

it.each(['white', 'transparent', 'unmapped glyph', 'wrong advance', 'covered ink'])(
  'requires complete visible scientific glyphs: %s',
  (mode) => {
    const f = scientificOrderFixture(),
      at = 1 + 5 * f.runs[5].sourceItem.index
    for (const context of [f.context, f.context.nativeGlyphContext]) {
      if (mode === 'white' || mode === 'transparent') {
        const op = mode === 'white' ? OPS.setFillRGBColor : OPS.setGState,
          value = mode === 'white' ? ['#ffffff'] : [[['ca', 0]]],
          reset = mode === 'white' ? ['#000000'] : [[['ca', 1]]]
        context.operators.fnArray.splice(at, 0, op)
        context.operators.argsArray.splice(at, 0, value)
        context.operators.fnArray.splice(at + 6, 0, op)
        context.operators.argsArray.splice(at + 6, 0, reset)
      }
      if (mode === 'unmapped glyph') context.operators.argsArray[at + 3][0][0].isInFont = false
      if (mode === 'wrong advance') context.operators.argsArray[at + 3][0][0].width *= 2
      if (mode === 'covered ink') {
        context.operators.fnArray.push(OPS.constructPath)
        context.operators.argsArray.push([
          OPS.fill,
          [[0, 40, 315, 1, 100, 315, 1, 100, 325, 1, 40, 325, 4]],
          [40, 315, 100, 325]
        ])
      }
    }
    if (mode === 'covered ink') {
      const g = {
        kind: 'path',
        operationIndex: f.context.operators.fnArray.length - 1,
        normalizedRect: [0.1, 0.1875, 0.25, 0.2125]
      }
      f.context.sourcePage.graphicsBounds.push(g)
      f.context.nativeGlyphContext.graphicsBounds.push(structuredClone(g))
    }
    assert.equal(check(f).unreliableMathSourceItems, undefined)
  }
)

it.each(['shape', 'transform', 'image identity', 'paint origin'])(
  'binds every image alias to its whole native operation: %s',
  (mode) => {
    const f = scientificOrderFixture(),
      index = addRemoteScientificImage(f)
    if (mode === 'shape') f.context.operators.argsArray[index][1]++
    if (mode === 'transform') f.context.operators.argsArray[index - 1][4]++
    if (mode === 'image identity') f.context.operators.argsArray[index][0] = 'ThirdName'
    if (mode === 'paint origin') {
      f.context.sourcePage.graphicsBounds[0].operationIndex--
      f.context.nativeGlyphContext.graphicsBounds[0].operationIndex--
    }
    assert.equal(check(f).unreliableMathSourceItems, undefined)
  }
)
