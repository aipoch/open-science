import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { scriptedFunctionHeader } = await import(
  pathToFileURL(resolve('test/fixtures/native-scripted-function-header.mjs')).href
)
const { nativeTableUnreliableMathSourceItems: collect } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-layout-conflicts.mjs')).href
)
const { reviewFinalNativeTableSources: review } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)
type Fixture = ReturnType<typeof JSON.parse>
const check = (f: Fixture): ReturnType<typeof JSON.parse> =>
  collect(f.table, f.tokens, f.rules, f.context)
it('protects every whole native source of a closed scripted header despite reading-order rectangles', () => {
  const f = scriptedFunctionHeader(),
    before = JSON.stringify(f),
    result = check(f)
  expect(result).toEqual(f.target.sourceItems)
  expect(JSON.stringify(f)).toBe(before)
})
const negatives: Record<string, (f: Fixture) => void> = {
  'missing closing run': (f) => {
    f.target.sourceItems.pop()
    f.target.sourceRects.pop()
  },
  'duplicate source': (f) => {
    f.target.sourceItems[3] = f.target.sourceItems[4]
  },
  'missing rectangle': (f) => {
    f.target.sourceRects.pop()
  },
  'duplicate rectangle': (f) => {
    f.target.sourceRects[3] = f.target.sourceRects[4]
  },
  'foreign rectangle': (f) => {
    f.target.sourceRects[3] = [0, 0, 1, 1]
  },
  'partial source segment': (f) => {
    f.target.sourceSegments = [{ ...f.target.sourceItems[0], start: 0, end: 1 }]
  },
  'shared cell origin': (f) => {
    f.cells.push({ ...f.target })
  },
  'duplicate native inventory': (f) => {
    f.tokens.push({ ...f.runs[3] })
  },
  'changed source label': (f) => {
    f.context.sourceContent.items[3].str = 'other'
  },
  'changed cell literal': (f) => {
    f.target.text = 'f(qotherupper)'
  },
  'ordinary row': (f) => {
    f.target.row = 1
  },
  'missing source context': (f) => {
    delete f.context.nativeGlyphContext
  },
  'different document': (f) => {
    f.context.sourceSha256 = 'b'.repeat(64)
  },
  'same baseline prose': (f) => {
    f.runs[3].baseline = f.runs[2].baseline
  },
  'body-sized script': (f) => {
    f.runs[3].height = f.runs[2].height
  },
  'nonuniform body tier': (f) => {
    f.runs[1].baseline += 1
  },
  'invalid crop': (f) => {
    f.table.cropRect[0] = Number.NaN
  },
  'foreign source order': (f) => {
    f.target.sourceItems[3] = f.tokens.at(-1).sourceItem
  },
  'missing font metric': (f) => {
    delete f.runs[3].fontAscent
  },
  'missing native glyph': (f) => {
    f.context.nativeGlyphContext.operators.argsArray[19][0][0].isInFont = false
  },
  'outside crop': (f) => {
    f.table.cropRect[0] = 31
  },
  'missing outline': (f) => {
    f.context.nativeGlyphContext.glyphBounds[0].glyphs.pop()
  },
  'unproved operator': (f) => {
    f.context.operators.argsArray[0] = ['#ff0000']
  },
  'foreign ink': (f) => {
    f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
      (g: Fixture) => g.fontChar === '3'
    ).bounds = [-4, 3, -3, 4]
  },
  'script ink touches sibling': (f) => {
    f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
      (g: Fixture) => g.fontChar === 'u'
    ).bounds = [0, -2, 0.4, 0.7]
  }
}
for (const [name, mutate] of Object.entries(negatives))
  it('declines scripted header attribution with ' + name, () => {
    const f = scriptedFunctionHeader()
    mutate(f)
    expect(check(f)).toEqual([])
  })

it('allows only a proven empty native source entry between complete header runs', () => {
  const f = scriptedFunctionHeader('empty')
  expect(check(f)).toEqual(f.target.sourceItems)
  const foreign = scriptedFunctionHeader('visible')
  expect(check(foreign)).toEqual([])
})
it('accepts source-order rectangles and either complete native tier serialization', () => {
  const f = scriptedFunctionHeader()
  f.target.sourceRects = f.runs.map((r: Fixture) => r.rect)
  f.target.text = 'f(qupperlower)'
  expect(check(f)).toEqual(f.target.sourceItems)
})

it('does not make a valid native mathematical table structurally unreliable', () => {
  const f = scriptedFunctionHeader(),
    before = JSON.stringify(f)
  const result = review(f.table, f.tokens, f.rules, [], f.context)
  expect(result).toBe(f.table)
  expect(result.issues).not.toContain('native-table-structure-ambiguous')
  expect(result.unreliableMathSourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

it('adds complete native math attribution to an already unreliable table without rewriting its grid', () => {
  const f = scriptedFunctionHeader()
  f.table.issues = ['native-table-structure-ambiguous']
  const before = JSON.stringify(f),
    result = review(f.table, f.tokens, f.rules, [], f.context)
  expect(result.unreliableMathSourceItems).toEqual(f.target.sourceItems)
  expect(result.issues).toBe(f.table.issues)
  for (const key of ['cells', 'grid', 'cropRect', 'thumbnail'])
    expect(result[key]).toBe(f.table[key])
  expect(JSON.stringify(f)).toBe(before)
})
it('does not treat an unrelated table warning as blocked mathematical ownership', () => {
  const f = scriptedFunctionHeader()
  f.table.issues = ['no-source-cell-grid']
  expect(review(f.table, f.tokens, f.rules, [], f.context)).toBe(f.table)
})
it.each(['missing native snapshot', 'changed source identity', 'duplicate native region'])(
  'does not let a pre-existing structural warning substitute for %s proof',
  (mode) => {
    const f = scriptedFunctionHeader()
    f.table.issues = ['native-table-structure-ambiguous']
    f.table.unreliableMathSourceItems = f.target.sourceItems
    if (mode === 'missing native snapshot') delete f.context.nativeGlyphContext
    if (mode === 'changed source identity') f.context.sourceSha256 = 'b'.repeat(64)
    if (mode === 'duplicate native region') f.target.sourceRects[3] = f.target.sourceRects[4]
    const result = review(f.table, f.tokens, f.rules, [], f.context)
    expect(result.unreliableMathSourceItems).toBeUndefined()
    expect(result.issues).toBe(f.table.issues)
    expect(result.cells).toBe(f.table.cells)
  }
)
