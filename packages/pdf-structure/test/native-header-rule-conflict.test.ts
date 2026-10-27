import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const { anonymousHeaderRule: fixture } = await import(
  pathToFileURL(resolve('test/fixtures/native-header-rule-conflict.mjs')).href
)
const { reviewFinalNativeHeaderRuleSources: review } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-header-rule-conflict.mjs')).href
)
const { nativeWholeCellInkPacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)

it('retains the complete native packet in the anonymous spanning-body fixture', () => {
  const f = fixture(),
    c = f.context.nativeGlyphContext,
    origins = f.table.cells.flatMap((cell) => cell.sourceItems)
  assert(
    nativeWholeCellInkPacket(
      f.context.sourcePage,
      c.content.items.map((i) => tableTextToken(i, c.viewport, 0)),
      c,
      {
        text: origins.map((i) => i.text).join(''),
        sourceItems: origins,
        sourceRects: origins.map(
          (o) => tableTextToken(c.content.items[o.index], c.viewport, 0).rect
        )
      }
    )
  )
})

it('suspends a header claiming complete native sources on both sides of the printed header rule', async () => {
  const f = fixture(),
    before = structuredClone(f.table),
    actual = await review(f.table, f.inventory, f.rules, f.context, () => Promise.resolve(f.png))
  assert.deepEqual(actual, {
    ...before,
    issues: ['native-table-structure-ambiguous'],
    reviewCandidate: false
  })
  assert.deepEqual(f.table, before)
})

it('retains typed native path arrays without evaluating incompatible prototype getters', async () => {
  const f = fixture()
  for (const [i, op] of f.context.operators.fnArray.entries())
    if (op === OPS.constructPath)
      f.context.operators.argsArray[i][1][0] = new Float32Array(
        f.context.operators.argsArray[i][1][0]
      )
  const actual = await review(f.table, f.inventory, f.rules, f.context, () =>
    Promise.resolve(f.png)
  )
  assert.deepEqual(actual, {
    ...f.table,
    issues: ['native-table-structure-ambiguous'],
    reviewCandidate: false
  })
})

for (const [name, options] of [
  ['wrapped header', { conflict: false }],
  ['missing printed separator pixels', { brokenRaster: true }],
  ['duplicate native separator identity', { duplicateSeparator: true }]
] as const) {
  it(`retains ${name}`, async () => {
    const f = fixture(options)
    assert.equal(
      await review(f.table, f.inventory, f.rules, f.context, () => Promise.resolve(f.png)),
      f.table
    )
  })
}

for (const field of [
  'nativeGlyphContext',
  'sourcePage',
  'sourceContent',
  'viewport',
  'nativePaintIdentityGraphics',
  'operators'
] as const) {
  it(`refuses an equal ${field} replacement during PNG loading`, async () => {
    const f = fixture()
    const output = await review(f.table, f.inventory, f.rules, f.context, () => {
      const value = f.context[field]
      f.context[field] = Array.isArray(value) ? [...value] : { ...value }
      if (field === 'sourceContent') f.context.content = f.context.sourceContent
      return Promise.resolve(f.png)
    })
    assert.equal(output, f.table)
  })
}

it('refuses a same-value font getter replacement during PNG loading', async () => {
  const f = fixture()
  f.context.nativeGlyphContext.fontGetter = () => f.context.nativeGlyphContext.glyphBounds
  const output = await review(f.table, f.inventory, f.rules, f.context, () => {
    f.context.nativeGlyphContext.fontGetter = () => f.context.nativeGlyphContext.glyphBounds
    return Promise.resolve(f.png)
  })
  assert.equal(output, f.table)
})

it('refuses a same-value viewport function replacement during PNG loading', async () => {
  const f = fixture()
  const output = await review(f.table, f.inventory, f.rules, f.context, () => {
    f.context.viewport.convertToViewportPoint = (x: number, y: number) => [x * 1.5, (190 - y) * 1.5]
    return Promise.resolve(f.png)
  })
  assert.equal(output, f.table)
})

for (const [name, mutate] of [
  [
    'missing native fonts',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds = undefined
    }
  ],
  [
    'source checksum mismatch',
    (f) => {
      f.context.sourceSha256 = 'b'.repeat(64)
    }
  ],
  [
    'missing source rectangle',
    (f) => {
      f.table.cells[0].sourceRects = []
    }
  ],
  [
    'incomplete header origin',
    (f) => {
      f.table.cells[1].sourceItems.pop()
    }
  ],
  [
    'NaN glyph bounds',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds[0] = NaN
    }
  ],
  [
    'unsupported blend mode',
    (f) => {
      f.context.operators.fnArray.push(OPS.setGState)
      f.context.operators.argsArray.push([[['BM', 'Multiply']]])
    }
  ],
  [
    'unsupported soft mask',
    (f) => {
      f.context.operators.fnArray.push(OPS.setGState)
      f.context.operators.argsArray.push([[['SMask', true]]])
    }
  ],
  [
    'nonopaque paint',
    (f) => {
      const i = f.context.operators.fnArray.indexOf(OPS.beginText)
      f.context.operators.fnArray.splice(i, 0, OPS.setGState)
      f.context.operators.argsArray.splice(i, 0, [[['ca', 0.5]]])
    }
  ]
] as const) {
  it(`retains ${name}`, async () => {
    const f = fixture()
    mutate(f)
    assert.equal(
      await review(f.table, f.inventory, f.rules, f.context, () => Promise.resolve(f.png)),
      f.table
    )
  })
}

it('excludes every foreign glyph with positive ink even when Unicode is whitespace', async () => {
  const f = fixture(),
    o = f.context.operators,
    index = o.fnArray.lastIndexOf(OPS.showText),
    raw = f.context.content.items.at(-1)
  o.argsArray[index][0][0].unicode = ' '
  o.argsArray[index][0][0].isSpace = true
  o.argsArray[index - 1][0][4] = 120
  o.argsArray[index - 1][0][5] = 120
  raw.str = ' '
  raw.sourceItem.text = ' '
  raw.transform[4] = 120
  raw.transform[5] = 120
  f.inventory.pop()
  assert.equal(
    await review(f.table, f.inventory, f.rules, f.context, () => Promise.resolve(f.png)),
    f.table
  )
})

it('refuses asynchronous metadata mutation without changing any input table object', async () => {
  const f = fixture(),
    original = structuredClone(f.table)
  assert.equal(
    await review(f.table, f.inventory, f.rules, f.context, () => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds[0] += 0.01
      return Promise.resolve(f.png)
    }),
    f.table
  )
  assert.deepEqual(f.table, original)
})

it('refuses a same-value accessor replacement during PNG loading', async () => {
  const f = fixture()
  Object.defineProperty(f.context.nativeGlyphContext, 'fontGetter', {
    get: () => f.context.nativeGlyphContext.glyphBounds,
    enumerable: true,
    configurable: true
  })
  assert.equal(
    await review(f.table, f.inventory, f.rules, f.context, () => {
      Object.defineProperty(f.context.nativeGlyphContext, 'fontGetter', {
        get: () => f.context.nativeGlyphContext.glyphBounds,
        enumerable: true,
        configurable: true
      })
      return Promise.resolve(f.png)
    }),
    f.table
  )
})

for (const mutation of ['none', 'prototype descriptor', 'prototype identity'] as const) {
  it(`binds the real page viewport and refuses ${mutation} mutation during PNG loading`, async () => {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 190] /Resources << >> >>'
    ]
    let pdf = '%PDF-1.4\n'
    const offsets = objects.map((object, index) => {
      const offset = pdf.length
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
      return offset
    })
    const xref = pdf.length
    pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    const task = getDocument({
      data: new Uint8Array(Buffer.from(pdf)),
      disableFontFace: true,
      useSystemFonts: false
    })
    try {
      const document = await task.promise,
        page = await document.getPage(1),
        f = fixture()
      f.context.viewport = page.getViewport({ scale: 1.5 })
      const prototype = Object.create(Object.getPrototypeOf(f.context.viewport))
      Object.setPrototypeOf(f.context.viewport, prototype)
      const before = structuredClone(f.table)
      const actual = await review(f.table, f.inventory, f.rules, f.context, async () => {
        if (mutation === 'prototype descriptor')
          Object.defineProperty(prototype, 'runtimeWitness', { get: () => 1, configurable: true })
        if (mutation === 'prototype identity')
          Object.setPrototypeOf(f.context.viewport, Object.create(prototype))
        return f.png
      })
      if (mutation === 'none')
        assert.deepEqual(actual, {
          ...before,
          issues: ['native-table-structure-ambiguous'],
          reviewCandidate: false
        })
      else assert.equal(actual, f.table)
    } finally {
      await task.destroy()
    }
  })
}

for (const field of ['sourceItems', 'sourceRects', 'sourceItem', 'viewport-transform'] as const) {
  for (const swap of [false, true]) {
    it(`binds inherited ${field} getter results and refuses reference replacement ${swap}`, async () => {
      const f = fixture()
      const object =
        field === 'sourceItem'
          ? f.inventory[0]
          : field === 'viewport-transform'
            ? f.context.viewport
            : f.table.cells[0]
      const key = field === 'viewport-transform' ? 'transform' : field
      let value = object[key]
      delete object[key]
      const prototype = Object.create(Object.getPrototypeOf(object))
      Object.defineProperty(prototype, key, { get: () => value, configurable: true })
      Object.setPrototypeOf(object, prototype)
      const actual = await review(f.table, f.inventory, f.rules, f.context, async () => {
        if (swap) value = Array.isArray(value) ? [...value] : { ...value }
        return f.png
      })
      if (field === 'viewport-transform' || swap) assert.equal(actual, f.table)
      else
        assert.deepEqual(actual, {
          ...f.table,
          issues: ['native-table-structure-ambiguous'],
          reviewCandidate: false
        })
    })
  }
}
