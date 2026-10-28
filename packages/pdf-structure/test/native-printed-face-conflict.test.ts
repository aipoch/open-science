import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { isDeepStrictEqual } from 'node:util'

const { anonymousPrintedFace: fixture } = await import(
  pathToFileURL(resolve('test/fixtures/native-printed-face-conflict.mjs')).href
)
const { reviewFinalNativeTableSources: finalReview } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)
const { reviewFinalNativePrintedFaceSources: printedReview } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-printed-face-conflict.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { nativeFractionInkPacket, nativeClosedPrintedFaceInkPacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { samePrintedFaceOperators } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-printed-face-packet.mjs')).href
)
const { collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)

type Fixture = ReturnType<typeof fixture>
async function review(f: Fixture): Promise<{ reviewCandidate: boolean }> {
  return printedReview(f.table, f.inventory, f.rules, f.context, () => Promise.resolve(f.png))
}
function rename(f: Fixture, index: number, str: string): void {
  const r = f.context.content.items[index]
  r.str = r.sourceItem.text = str
  f.inventory[index].text = str
  for (const c of f.table.cells) {
    c.text = c.sourceItems.map((s: { text: string }) => s.text).join(' ')
    f.table.grid[c.row][c.column] = c.text
  }
}
function foreignClip(f: Fixture): void {
  const o = f.context.operators,
    height = f.context.nativeGlyphContext.viewport.height,
    add = (op: number, args: unknown): void => {
      o.fnArray.push(op)
      o.argsArray.push(args)
    }
  add(OPS.save, null)
  add(OPS.eoClip, null)
  add(OPS.constructPath, [
    OPS.endPath,
    [[0, 20, height - 130, 1, 200, height - 130, 1, 200, height - 150, 1, 20, height - 150, 4]],
    [20, height - 150, 200, height - 130]
  ])
  add(OPS.beginText, null)
  add(OPS.setFont, ['F', 10])
  add(OPS.setTextMatrix, [[1, 0, 0, 1, 30, height - 140]])
  add(OPS.showText, [
    [{ unicode: ' ', fontChar: '!', width: 500, isInFont: false, isSpace: false }]
  ])
  add(OPS.endText, null)
  add(OPS.restore, null)
  f.context.nativeGlyphContext.glyphBounds[0].glyphs.push({
    fontChar: '!',
    bounds: [0, -0.1, 0.5, 0.7]
  })
  f.context.content.items.push({
    str: ' ',
    dir: 'ltr',
    width: 5,
    height: 10,
    transform: [10, 0, 0, 10, 30, height - 140],
    fontName: 'F',
    hasEOL: true,
    sourceItem: { pageNumber: 1, index: f.context.content.items.length, text: ' ' }
  })
}

function duplicateEdge(f: Fixture, offset = 0): void {
  const o = f.context.operators,
    i = o.fnArray.indexOf(OPS.constructPath),
    a = structuredClone(o.argsArray[i]),
    height = f.context.nativeGlyphContext.viewport.height,
    scale = f.context.viewport.scale
  a[1][0][2] -= offset
  a[1][0][5] -= offset
  a[2][1] -= offset
  a[2][3] -= offset
  o.fnArray.push(OPS.constructPath)
  o.argsArray.push(a)
  const g = structuredClone(f.context.sourcePage.graphicsBounds[0])
  g.operationIndex = o.fnArray.length - 1
  g.normalizedRect[1] += offset / height
  g.normalizedRect[3] += offset / height
  f.context.sourcePage.graphicsBounds.push(g)
  const id = structuredClone(f.context.nativePaintIdentityGraphics[0])
  id.operationIndex = g.operationIndex
  id.rect[1] += offset * scale
  id.rect[3] += offset * scale
  f.context.nativePaintIdentityGraphics.push(id)
  f.context.nativeEvidenceGraphics.push({ kind: id.kind, rect: id.rect })
  f.rules = collectTableRules(o, f.context.viewport)
}

it('suspends a whole header cell that crosses two independently printed faces', async () => {
  const f = fixture(),
    before = JSON.stringify(f.table),
    reviewed = finalReview(f.table, f.inventory, f.rules, [], f.context)
  assert.equal(reviewed.reviewCandidate, true)
  const out = await printedReview(reviewed, f.inventory, f.rules, f.context, () =>
    Promise.resolve(f.png)
  )
  assert.equal(out.reviewCandidate, false)
  assert.deepEqual(out.issues, ['native-table-structure-ambiguous'])
  for (const key of ['cells', 'grid', 'cropRect', 'thumbnail', 'notes'])
    assert.equal(out[key], f.table[key])
  assert.equal(JSON.stringify(f.table), before)
})

it('keeps canonical multiple characters of one physical glyph in the same whole record', async () => {
  const f = fixture(),
    i = f.context.operators.fnArray.indexOf(OPS.showText)
  rename(f, 0, 'Lábel')
  f.context.operators.argsArray[i][0][0].unicode = 'Lábel'
  assert.equal((await review(f)).reviewCandidate, false)
})

it('retains positive foreign notdef ink behind a complete disjoint native clip', async () => {
  const f = fixture()
  foreignClip(f)
  const p = f.context.nativeGlyphContext,
    tokens = p.content.items
      .filter((r: { str: string }) => r.str.trim())
      .map((r: unknown) => tableTextToken(r, p.viewport, 0)),
    items = f.table.cells[1].sourceItems
  assert.equal(nativeFractionInkPacket(f.context.sourcePage, tokens, p, items), undefined)
  const packet = nativeClosedPrintedFaceInkPacket(
      f.context.sourcePage,
      tokens,
      p,
      items,
      [18, 28, 202, 112]
    ),
    glyph = packet.glyphs.at(-1)
  assert.equal(glyph.rendererSkipped, undefined)
  assert.equal(glyph.excludedByClosedFaceClip, true)
  assert(glyph.ink[2] > glyph.ink[0] && glyph.ink[3] > glyph.ink[1])
  assert.equal(glyph.text, ' ')
  assert.equal((await review(f)).reviewCandidate, false)
})

it('interprets explicitly opaque ordinary paint state only through the new caller', async () => {
  const f = fixture(),
    o = f.context.operators
  o.fnArray[2] = OPS.setGState
  o.argsArray[2] = [
    [
      ['BM', 'source-over'],
      ['CA', 1],
      ['ca', 1],
      ['LC', 0],
      ['LJ', 0],
      ['LW', 0.6],
      ['ML', 4]
    ]
  ]
  assert.equal((await review(f)).reviewCandidate, false)
})

const negatives: [string, (f: Fixture) => void][] = [
  [
    'a legitimate rowspan',
    (f) => {
      f.table.cells[1].rowSpan = 2
    }
  ],
  [
    'measured segments',
    (f) => {
      f.table.cells[1].sourceSegments = [{}]
    }
  ],
  [
    'a duplicate whole claim',
    (f) => {
      f.table.cells[2].sourceItems.push(f.table.cells[1].sourceItems[0])
    }
  ],
  [
    'a changed source rectangle',
    (f) => {
      f.table.cells[1].sourceRects[0][0]++
    }
  ],
  [
    'a missing font program',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds = []
    }
  ],
  [
    'a nonfinite outline',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds[0] = NaN
    }
  ],
  [
    'a zero source height',
    (f) => {
      f.context.content.items[0].height = 0
    }
  ],
  [
    'a zero claimed advance',
    (f) => {
      f.context.content.items[0].width = 0
    }
  ],
  [
    'unknown blending',
    (f) => {
      f.context.operators.fnArray[2] = OPS.setGState
      f.context.operators.argsArray[2] = [[['BM', 'multiply']]]
    }
  ],
  [
    'an active soft mask',
    (f) => {
      f.context.operators.fnArray[2] = OPS.setGState
      f.context.operators.argsArray[2] = [[['SMask', true]]]
    }
  ],
  [
    'a missing native glyph',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.shift()
    }
  ],
  [
    'unproved Type3 paint',
    (f) => {
      const i = f.context.operators.fnArray.indexOf(OPS.showText)
      f.context.operators.argsArray[i][0][0].operatorListId = 'unproved'
    }
  ],
  [
    'foreign space without a disjoint clip',
    (f) => {
      foreignClip(f)
      const i = f.context.operators.fnArray.lastIndexOf(OPS.eoClip)
      f.context.operators.argsArray[i + 1] = [
        OPS.endPath,
        [[0, 20, 150, 1, 200, 150, 1, 200, 100, 1, 20, 100, 4]],
        [20, 100, 200, 150]
      ]
    }
  ],
  [
    'an incomplete foreign outline',
    (f) => {
      foreignClip(f)
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.pop()
    }
  ],
  [
    'an equal native edge candidate',
    (f) => {
      duplicateEdge(f)
    }
  ],
  [
    'an overlapping native edge candidate',
    (f) => {
      duplicateEdge(f, 0.1)
    }
  ],
  [
    'undefined text paint',
    (f) => {
      f.context.operators.argsArray[0] = []
    }
  ]
]
it.each(negatives)('retains the original table with %s', async (_label, mutate) => {
  const f = fixture()
  mutate(f)
  assert.equal(await review(f), f.table)
})

it.each([' ', ''])(
  'refuses an unowned positive-ink %j glyph in an owned text object',
  async (text) => {
    const f = fixture(),
      i = f.context.operators.fnArray.indexOf(OPS.showText)
    f.context.operators.argsArray[i][0].push({
      unicode: text,
      fontChar: '!',
      width: 0,
      isInFont: true,
      isSpace: text === ' '
    })
    f.context.nativeGlyphContext.glyphBounds[0].glyphs.push({
      fontChar: '!',
      bounds: [-1, -0.1, -0.5, 0.7]
    })
    assert.equal(await review(f), f.table)
  }
)

it('refuses physical glyph sharing across two whole source records', async () => {
  const f = fixture(),
    o = f.context.operators,
    shows = o.fnArray.flatMap((op: number, i: number) => (op === OPS.showText ? [i] : []))
  rename(f, 0, 'A')
  rename(f, 1, 'B')
  o.argsArray[shows[0]][0][0] = { unicode: 'AB', fontChar: '!', width: 500, isInFont: true }
  o.argsArray[shows[1]] = [[]]
  f.context.nativeGlyphContext.glyphBounds[0].glyphs.push({
    fontChar: '!',
    bounds: [0, -0.1, 0.5, 0.7]
  })
  for (const index of [0, 1]) {
    const r = f.context.content.items[index]
    r.width = 5
    r.transform = [...f.context.content.items[0].transform]
    f.inventory[index] = tableTextToken(r, f.context.viewport, 0)
    for (const c of f.table.cells)
      for (let i = 0; i < c.sourceItems.length; i++)
        if (c.sourceItems[i].index === index) c.sourceRects[i] = f.inventory[index].rect
  }
  assert.equal(await review(f), f.table)
})

it.each(['source', 'native-font', 'png'])(
  'rejects %s mutation while an asynchronous PNG is pending',
  async (field) => {
    const f = fixture(),
      out = await printedReview(f.table, f.inventory, f.rules, f.context, () => {
        queueMicrotask(() =>
          queueMicrotask(() => {
            if (field === 'source') f.table.cells[1].text += 'x'
            else if (field === 'native-font')
              f.context.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds[0]++
            else f.png.fill(0)
          })
        )
        return Promise.resolve(f.png)
      })
    assert.equal(out, f.table)
  }
)

it('requires real opaque corner closure in the actual crop', async () => {
  const f = fixture(),
    image = await loadImage(f.png),
    canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d')
  try {
    ctx.drawImage(image, 0, 0)
    ctx.fillStyle = 'white'
    ctx.fillRect(238, 98, 8, 10)
    f.png = canvas.toBuffer('image/png')
    assert.equal(await review(f), f.table)
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
})

it('refuses a crop that erased owned glyph ink while retaining every border', async () => {
  const f = fixture(),
    image = await loadImage(f.png),
    canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d')
  try {
    ctx.drawImage(image, 0, 0)
    ctx.fillStyle = 'white'
    ctx.fillRect(300, 36, 110, 40)
    f.png = canvas.toBuffer('image/png')
    assert.equal(await review(f), f.table)
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
})

it('compares image handles only in declared paint and dependency roles', () => {
  const program = (a: string, b: string): { fnArray: number[]; argsArray: unknown[][] } => ({
      fnArray: [
        OPS.dependency,
        OPS.paintImageXObject,
        OPS.dependency,
        OPS.paintImageXObject,
        OPS.showText
      ],
      argsArray: [
        [a],
        [a, 4, 5],
        [b],
        [b, 1, 5],
        [[{ unicode: 'image-a', fontChar: 'literal', width: 500 }]]
      ]
    }),
    native = program('image-a', 'image-b'),
    work = program('cache-a', 'cache-b')
  assert(samePrintedFaceOperators(native, work, new Map()))
  const bad = structuredClone(work)
  bad.argsArray[4] = [[{ unicode: 'cache-a', fontChar: 'literal', width: 500 }]]
  assert(!samePrintedFaceOperators(native, bad, new Map()))
  for (const modify of [
    (p: typeof work): void => {
      p.argsArray[3][0] = 'cache-a'
      p.argsArray[2][0] = 'cache-a'
    },
    (p: typeof work): void => {
      p.argsArray[0][0] = 'cache-b'
    },
    (p: typeof work): void => {
      p.argsArray[1][1] = 6
    }
  ]) {
    const next = structuredClone(work)
    modify(next)
    assert(!samePrintedFaceOperators(native, next, new Map()))
  }
  const pattern = (p: typeof native): { fnArray: number[]; argsArray: unknown[][] } => ({
    fnArray: [OPS.setFillColorN],
    argsArray: [
      [
        'TilingPattern',
        null,
        { ...p, length: p.fnArray.length },
        [1, 0, 0, 1, 0, 0],
        [0, 0, 8, 8],
        8,
        8,
        1,
        1
      ]
    ]
  })
  assert(samePrintedFaceOperators(pattern(native), pattern(work), new Map()))
  assert(!samePrintedFaceOperators(pattern(native), pattern(bad), new Map()))
  assert(!samePrintedFaceOperators(native, work, new Map([['image-a', 'cache-a']])))
  assert(isDeepStrictEqual(native, program('image-a', 'image-b')))
})
