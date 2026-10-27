import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { resolve } from './paths'

const { captionedTableConflict: fixture } = await import(
  pathToFileURL(resolve('test/fixtures/captioned-table-conflict.mjs')).href
)
const { refuseFigureBorrowingCaptionedTable: refuse } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-captioned-table-conflict.mjs')).href
)
type Fixture = ReturnType<typeof fixture>

it('retains the independent whole-table veto when cell mapping is suspended', () => {
  const f = fixture()
  f.tables[0].reviewCandidate = false
  f.tables[0].issues = ['native-table-structure-ambiguous']
  const before = JSON.stringify(f.tables),
    actual = refuse(f.page, f.figure, f.tables, f.tokens, f.context)
  assert.equal(actual.region, undefined)
  assert.equal(actual.thumbnail, undefined)
  assert.equal(actual.issue, 'no-unambiguous-adjacent-graphics')
  assert.equal(JSON.stringify(f.tables), before)
})

it.each([
  'missing-source',
  'missing-boundary',
  'extra-issue',
  'shared-caption',
  'figure-caption',
  'missing-font'
])('still requires complete independent evidence after suspension: %s', (fault) => {
  const f = fixture()
  f.tables[0].reviewCandidate = false
  f.tables[0].issues = ['native-table-structure-ambiguous']
  if (fault === 'missing-source') f.tables[0].cells.pop()
  if (fault === 'missing-boundary') f.tables[0].cropRect = []
  if (fault === 'extra-issue') f.tables[0].issues.push('unknown-native-state')
  if (fault === 'shared-caption') f.tables[0].caption = f.figure.caption
  if (fault === 'figure-caption') f.tables[0].caption.lines[0] = 'Figure 1: Shared body'
  if (fault === 'missing-font') f.context.glyphBounds = []
  assert.equal(refuse(f.page, f.figure, f.tables, f.tokens, f.context), f.figure)
})

it('withdraws an unproved figure region containing every source of a separately captioned table', () => {
  const f = fixture(),
    before = JSON.stringify(f.tables)
  const actual = refuse(f.page, f.figure, f.tables, f.tokens, f.context)
  assert.equal(actual.region, undefined)
  assert.equal(actual.thumbnail, undefined)
  assert.equal(actual.issue, 'no-unambiguous-adjacent-graphics')
  assert.deepEqual(actual.caption, f.figure.caption)
  assert.equal(actual.graphicsCount, f.figure.graphicsCount)
  assert.equal(JSON.stringify(f.tables), before)
  const expected = { ...f.figure, issue: 'no-unambiguous-adjacent-graphics' }
  delete expected.region
  delete expected.thumbnail
  assert.deepEqual(actual, expected)
})

const controls: Array<[string, (f: Fixture) => void]> = [
  [
    'minor region intersection without the whole table source',
    (f) => {
      f.figure.region[1] = 65 / 200
    }
  ],
  [
    'one source record outside the figure',
    (f) => {
      f.figure.region[2] = 90 / 200
    }
  ],
  [
    'captionless table',
    (f) => {
      delete f.tables[0].caption
    }
  ],
  [
    'a figure-captioned table presentation',
    (f) => {
      f.tables[0].caption.lines[0] = 'Figure 1: Inputs'
    }
  ],
  [
    'a shared caption',
    (f) => {
      f.tables[0].caption = f.figure.caption
    }
  ],
  [
    'two conflicting table owners',
    (f) => {
      f.tables.push(JSON.parse(JSON.stringify(f.tables[0])))
    }
  ],
  [
    'a previously proved figure source owner',
    (f) => {
      f.figure.sourceItems = [f.context.content.items[1].sourceItem]
    }
  ],
  [
    'a partial native table',
    (f) => {
      f.tables[0].cells.pop()
    }
  ],
  [
    'an unassigned table source',
    (f) => {
      f.tables[0].unassigned.push(f.tables[0].cells[0])
    }
  ],
  [
    'a clipped table source',
    (f) => {
      f.tables[0].clipped.push(f.tables[0].cells[0])
    }
  ],
  [
    'an unresolved table issue',
    (f) => {
      f.tables[0].issues.push('ambiguous-source-cell-mapping')
    }
  ],
  [
    'a table outside the review candidates',
    (f) => {
      f.tables[0].reviewCandidate = false
    }
  ],
  [
    'a segmented source claim',
    (f) => {
      f.tables[0].cells[0].sourceSegments = [{ start: 0, end: 1 }]
    }
  ],
  [
    'a malformed source segment list',
    (f) => {
      f.tables[0].cells[0].sourceSegments = {}
    }
  ],
  [
    'malformed empty-cell source evidence',
    (f) => {
      f.tables[0].cells.push({ text: '', sourceItems: {} })
    }
  ],
  [
    'a source text substitution',
    (f) => {
      f.tables[0].cells[0].sourceItems[0] = {
        ...f.tables[0].cells[0].sourceItems[0],
        text: 'Other'
      }
    }
  ],
  [
    'a cell text unrelated to its sources',
    (f) => {
      f.tables[0].cells[0].text = 'Other'
    }
  ],
  [
    'a shifted source rectangle',
    (f) => {
      f.tables[0].cells[0].sourceRects[0][0] += 1
    }
  ],
  [
    'a shared native source index',
    (f) => {
      f.tables[0].cells[1].sourceItems[0] = f.tables[0].cells[0].sourceItems[0]
    }
  ],
  [
    'a missing body source token',
    (f) => {
      f.tokens.splice(1, 1)
    }
  ],
  [
    'a duplicated body source token',
    (f) => {
      f.tokens.push(f.tokens[1])
    }
  ],
  [
    'a missing title source token',
    (f) => {
      f.tokens.shift()
    }
  ],
  [
    'an incomplete title boundary',
    (f) => {
      f.tables[0].caption.rect[2] -= 1
    }
  ],
  [
    'a title crossing the body',
    (f) => {
      f.tables[0].caption.rect[3] = 51
    }
  ],
  [
    'an incomplete crop boundary',
    (f) => {
      f.tables[0].cropRect[0] = 70
    }
  ],
  [
    'a foreign source inside the table boundary',
    (f) => {
      const r = {
        ...f.context.content.items[1],
        str: 'Foreign',
        width: 20,
        sourceItem: { pageNumber: 1, index: 5, text: 'Foreign' }
      }
      f.context.content.items.push(r)
    }
  ],
  [
    'missing explicit native font ascent',
    (f) => {
      delete f.context.content.styles['fixture-font'].ascent
    }
  ],
  [
    'zero native font ascent',
    (f) => {
      f.context.content.styles['fixture-font'].ascent = 0
    }
  ],
  [
    'missing explicit native font descent',
    (f) => {
      delete f.context.content.styles['fixture-font'].descent
    }
  ],
  [
    'missing font glyph bounds',
    (f) => {
      f.context.glyphBounds = []
    }
  ],
  [
    'malformed font glyph bounds',
    (f) => {
      f.context.glyphBounds[0].glyphs[0].bounds[0] = NaN
    }
  ],
  [
    'two fonts claiming the same native name',
    (f) => {
      f.context.glyphBounds.push(f.context.glyphBounds[0])
    }
  ],
  [
    'a rotated native page',
    (f) => {
      f.page.rotation = 90
    }
  ],
  [
    'a rotated table',
    (f) => {
      f.tables[0].readingRotation = 90
    }
  ],
  [
    'a mismatched viewport',
    (f) => {
      f.context.viewport.width += 1
    }
  ],
  [
    'a missing source checksum',
    (f) => {
      delete f.context.sourceSha256
    }
  ],
  [
    'a foreign page identity',
    (f) => {
      f.context.pageNumber = 2
    }
  ]
]

for (const [name, mutate] of controls) {
  it(`retains the existing preview for ${name}`, () => {
    const f = fixture()
    mutate(f)
    const before = JSON.stringify(f)
    assert.equal(refuse(f.page, f.figure, f.tables, f.tokens, f.context), f.figure)
    assert.equal(JSON.stringify(f), before)
  })
}

it('accepts empty cells without inventing additional source claims', () => {
  const f = fixture()
  f.tables[0].cells.push({ row: 2, column: 0, rowSpan: 1, colSpan: 1, text: '' })
  assert.equal(refuse(f.page, f.figure, f.tables, f.tokens, f.context).region, undefined)
})

it('leaves a caption-only figure and a missing native context unchanged', () => {
  const f = fixture()
  assert.equal(refuse(f.page, f.figure, f.tables, f.tokens, undefined), f.figure)
  delete f.figure.region
  delete f.figure.thumbnail
  assert.equal(refuse(f.page, f.figure, f.tables, f.tokens, f.context), f.figure)
})
