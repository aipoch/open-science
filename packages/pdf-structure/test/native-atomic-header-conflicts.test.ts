import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { anonymousAtomicHeader: fixture } = await import(
  pathToFileURL(resolve('test/fixtures/native-atomic-header-conflicts.mjs')).href
)
const { reviewFinalNativeTableSources: finalReview, reviewNativeTableSources: earlyReview } =
  await import(pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href)
const { reviewFinalNativeAtomicHeaderSources: atomicReview } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-atomic-header-conflicts.mjs')).href
)
type Fixture = ReturnType<typeof fixture>

async function unchanged(f: Fixture): Promise<void> {
  const out = await atomicReview(f.table, f.inventory, f.rules, f.context, () =>
    Promise.resolve(f.png)
  )
  assert.equal(out, f.table)
}

function foreignSpace(f: Fixture, emptyOutline = false): void {
  const o = f.context.operators,
    i = o.fnArray.lastIndexOf(OPS.showText),
    glyph = o.argsArray[i][0][0],
    raw = f.context.content.items.at(-1),
    outline = f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
      (g) => g.fontChar === 'Outside'
    )
  glyph.unicode = ' '
  glyph.fontChar = '!'
  glyph.isSpace = true
  outline.fontChar = '!'
  if (emptyOutline) outline.bounds = [0, 0, 0, 0]
  raw.str = ' '
  raw.sourceItem.text = ' '
  raw.transform[4] = 35
  raw.transform[5] = f.context.nativeGlyphContext.viewport.height - 65
  o.argsArray[i - 1][0][4] = 35
  o.argsArray[i - 1][0][5] = raw.transform[5]
  f.inventory.pop()
}

function unrepresentedHeaderGlyph(f: Fixture, outside: boolean, text: string): void {
  const o = f.context.operators,
    i = o.fnArray.indexOf(OPS.showText)
  o.argsArray[i][0].push({
    unicode: text,
    fontChar: '!',
    width: 0,
    isInFont: true,
    isSpace: text === ' '
  })
  f.context.nativeGlyphContext.glyphBounds[0].glyphs.push({
    fontChar: '!',
    bounds: outside ? [-5, -0.1, -4, 0.7] : [0, -0.1, 0.5, 0.7]
  })
}

function sharedPhysicalGlyph(f: Fixture, body: boolean): void {
  const o = f.context.operators,
    shows = o.fnArray.flatMap((op: number, i: number) => (op === OPS.showText ? [i] : [])),
    raw = f.context.content.items,
    pairs = body
      ? [[8, 12]]
      : [
          [0, 1],
          [2, 3],
          [4, 5],
          [6, 7]
        ]
  for (const [first, second] of pairs) {
    const a = raw[first],
      b = raw[second],
      cells = [a, b].map((r) =>
        f.table.cells.find((c) => c.sourceItems[0].index === r.sourceItem.index)
      ),
      native = [a, b].map((r) =>
        f.inventory.find((t) => t.sourceItem.index === r.sourceItem.index)
      ),
      glyph = o.argsArray[shows[first]][0][0],
      outline = f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
        (g) => g.fontChar === glyph.fontChar
      ),
      texts = body ? ['1', '5'] : ['A', 'B']
    if (!f.context.nativeGlyphContext.glyphBounds[0].glyphs.some((g) => g.fontChar === '!'))
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.push({
        fontChar: '!',
        bounds: [...outline.bounds]
      })
    glyph.unicode = texts.join('')
    glyph.fontChar = '!'
    o.argsArray[shows[second]] = [[]]
    for (const [i, r] of [a, b].entries()) {
      r.str = texts[i]
      r.sourceItem.text = texts[i]
      native[i].text = texts[i]
      cells[i].text = texts[i]
      f.table.grid[cells[i].row][cells[i].column] = texts[i]
    }
    b.width = a.width
    b.transform = [...a.transform]
    native[1].rect = [...native[0].rect]
    native[1].baseline = native[0].baseline
    cells[1].sourceRects = [[...cells[0].sourceRects[0]]]
    const owners = new Map(
      raw.map((r) => [r, f.inventory.find((t) => t.sourceItem.index === r.sourceItem.index)])
    )
    raw.splice(raw.indexOf(b), 1)
    raw.splice(raw.indexOf(a) + 1, 0, b)
    raw.forEach((r, index) => {
      r.sourceItem.index = index
      owners.get(r).sourceItem = r.sourceItem
    })
  }
}

it('suspends two logical header rows that split independently framed whole native cells', async () => {
  const f = fixture(),
    before = JSON.stringify(f.table),
    early = earlyReview(f.table, f.inventory),
    final = finalReview(early, f.inventory, f.rules, [], f.context),
    out = await atomicReview(final, f.inventory, f.rules, f.context, () => Promise.resolve(f.png))
  assert(!early.issues.includes('native-table-structure-ambiguous'))
  assert(out.issues.includes('native-table-structure-ambiguous'))
  assert.equal(out.reviewCandidate, false)
  for (const field of ['cells', 'grid', 'cropRect', 'thumbnail', 'notes'])
    assert.equal(out[field], f.table[field])
  assert.equal(JSON.stringify(f.table), before)
})

it('keeps the original table when a claimed inventory font has zero height', async () => {
  const f = fixture()
  f.inventory[0].height = 0
  const out = await atomicReview(f.table, f.inventory, f.rules, f.context, () =>
    Promise.resolve(f.png)
  )
  assert.equal(out, f.table)
})

it('keeps one logical spanning header cell with both complete native runs', async () => {
  const f = fixture()
  for (let column = 0; column < 4; column++) {
    const a = f.table.cells.find((c) => c.row === 0 && c.column === column),
      b = f.table.cells.find((c) => c.row === 1 && c.column === column)
    a.sourceItems.push(...b.sourceItems)
    a.sourceRects.push(...b.sourceRects)
    a.text += ' ' + b.text
    a.rowSpan = 2
    f.table.grid[0][column] = a.text
    f.table.grid[1][column] = ''
    f.table.cells = f.table.cells.filter((c) => c !== b)
  }
  await unchanged(f)
})

it.each([
  ['a real printed row divider', { headerDivider: true }],
  ['one text object spanning multiple columns', { sharedHeaderPacket: true }],
  ['unowned diagonal paint in the header', { extraPaint: true }],
  ['a gap in the actual raster frame', { brokenRaster: true }]
])('does not suspend mapping with %s', async (_name, options) => {
  await unchanged(fixture(options))
})

it.each(['missing', 'NaN', 'zero-height'])('refuses %s native font evidence', async (mode) => {
  const f = fixture()
  if (mode === 'missing') f.context.nativeGlyphContext.glyphBounds = []
  else if (mode === 'NaN') f.context.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds[0] = NaN
  else f.context.content.items[0].height = 0
  await unchanged(f)
})

it('does not interpret measured source segments as atomic whole header owners', async () => {
  const f = fixture(),
    a = f.table.cells[0]
  a.sourceSegments = [{ ...a.sourceItems[0], start: 0, end: a.text.length, rect: a.sourceRects[0] }]
  await unchanged(f)
})

it.each(['blend', 'group', 'type3'])('retains the existing %s packet refusal', async (mode) => {
  const f = fixture(),
    o = f.context.operators
  if (mode === 'blend') {
    o.fnArray.push(OPS.setGState)
    o.argsArray.push([[['BM', 'source-over']]])
  } else if (mode === 'group') {
    o.fnArray.push(OPS.beginGroup)
    o.argsArray.push([{}])
  } else {
    const i = o.fnArray.indexOf(OPS.showText)
    o.argsArray[i][0][0].fontChar = ''
    o.argsArray[i][0][0].operatorListId = 'unproved-program'
  }
  await unchanged(f)
})

it('refuses an incomplete foreign native source inventory', async () => {
  const f = fixture()
  f.context.content.items.pop()
  await unchanged(f)
})

it('refuses a missing native paint identity', async () => {
  const f = fixture()
  f.context.nativePaintIdentityGraphics.pop()
  await unchanged(f)
})

it('does not publish a proof if native owners change while loading the image', async () => {
  const f = fixture(),
    out = await atomicReview(f.table, f.inventory, f.rules, f.context, async () => {
      f.table.cells[0].text += ' changed'
      return f.png
    })
  assert.equal(out, f.table)
  assert.deepEqual(out.issues, [])
})

it('does not accept a raster with different encoded dimensions', async () => {
  const f = fixture()
  f.png.writeUInt32BE(1, 16)
  await unchanged(f)
})

it('keeps the original table when image loading fails', async () => {
  const f = fixture(),
    out = await atomicReview(f.table, f.inventory, f.rules, f.context, async () => {
      throw new Error('unavailable image')
    })
  assert.equal(out, f.table)
})

it('does not extend an ordinary header proof to differently sized native text', async () => {
  await unchanged(fixture({ smallSecondLine: true }))
})

it('recognizes the same complete frame when a horizontal stroke is reversed', async () => {
  const f = fixture({ reverseBottom: true }),
    out = await atomicReview(f.table, f.inventory, f.rules, f.context, () => Promise.resolve(f.png))
  assert(out.issues.includes('native-table-structure-ambiguous'))
  assert.equal(out.reviewCandidate, false)
})

it('does not certify a frame when the raster has no edge samples', async () => {
  const f = fixture({ geometryScale: 1 / 1024 })
  assert.equal(f.png.readUInt32BE(16), 1)
  assert.equal(f.png.readUInt32BE(20), 1)
  await unchanged(f)
})

it('refuses foreign painted whitespace that has no visible source record', async () => {
  const f = fixture()
  foreignSpace(f)
  await unchanged(f)
})

it.each([
  [' ', false],
  ['', false],
  ['', true]
])('refuses unrepresented header glyph %j with outside-face ink %s', async (text, outside) => {
  const f = fixture()
  unrepresentedHeaderGlyph(f, outside, text)
  await unchanged(f)
})

it('keeps a complete proof when a foreign space has a proven empty outline', async () => {
  const f = fixture()
  foreignSpace(f, true)
  const out = await atomicReview(f.table, f.inventory, f.rules, f.context, () =>
    Promise.resolve(f.png)
  )
  assert(out.issues.includes('native-table-structure-ambiguous'))
})

it.each([false, true])(
  'refuses physical glyph sharing across whole records in body=%s',
  async (body) => {
    const f = fixture()
    sharedPhysicalGlyph(f, body)
    await unchanged(f)
  }
)

it('retains exact NFD text and repeated parts of one multichar physical glyph', async () => {
  const f = fixture(),
    text = 'De\u0301but',
    i = f.context.operators.fnArray.indexOf(OPS.showText)
  f.context.operators.argsArray[i][0][0].unicode = text
  f.context.content.items[0].str = text
  f.context.content.items[0].sourceItem.text = text
  f.inventory[0].text = text
  f.table.cells[0].text = text
  f.table.grid[0][0] = text
  const before = JSON.stringify(f.table),
    out = await atomicReview(f.table, f.inventory, f.rules, f.context, () => Promise.resolve(f.png))
  assert(out.issues.includes('native-table-structure-ambiguous'))
  assert.equal(JSON.stringify(f.table), before)
  assert.equal(out.cells[0].text, text)
})
