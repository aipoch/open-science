import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const {
  createNativeRunningFolioFrame: frame,
  reviewNativeRunningFolioConflict: review,
  nativeRunningFolioClaim: claim
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-running-folio-conflict.mjs')).href
)

function fixture(fault = ''): {
  frames: unknown[]
  table: Record<string, unknown>
  mutate: () => void
  mutateContext: () => void
  mutateBuffer: () => void
} {
  const font = {
      loadedName: 'Current',
      data: new Uint8Array([0, 1, 2, 3]),
      missingFile: false,
      isType3Font: false,
      isInvalidPDFjsFont: false,
      vertical: false,
      fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      ascent: 0.8,
      descent: -0.2,
      remeasure: false,
      name: 'Anonymous embedded font'
    },
    otherFont = { ...font, loadedName: 'Other', data: new Uint8Array([4, 3, 2, 1]) },
    objects = { get: (name: string): unknown => (name === 'Other' ? otherFont : font) },
    frames: unknown[] = []
  if (fault === 'undeclared-remeasure')
    Object.defineProperty(font, 'remeasure', { value: undefined })
  if (fault === 'remeasure') font.remeasure = true
  if (fault === 'unknown-vertical') Object.defineProperty(font, 'vertical', { value: undefined })
  if (fault === 'fresh-view' || fault === 'changing-buffer') {
    const bytes = font.data
    Object.defineProperty(font, 'data', {
      configurable: true,
      get: (): Uint8Array =>
        fault === 'changing-buffer'
          ? new Uint8Array(bytes)
          : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    })
  }
  let middle: unknown, contextMutation: (() => void) | undefined
  for (const number of [11, 12, 13]) {
    const value = String(fault === 'wrong-number' && number === 13 ? 14 : number),
      currentFont = fault === 'different-program' && number === 13 ? 'Other' : 'Current',
      y = fault === 'body-number' ? 500 : 50,
      sourceY = number === 11 ? y + 1e-14 : y,
      style = { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'serif' },
      body = {
        str: 'X',
        dir: 'ltr',
        fontName: 'Old',
        width: 5,
        height: 10,
        transform: [10, 0, 0, 10, 80, fault === 'foreign-margin-glyph' ? 45 : 600],
        hasEOL: true
      },
      footer = {
        str: value,
        dir: 'ltr',
        fontName: 'Old',
        width: 10,
        height: 10,
        transform: [10, 0, 0, 10, 295, sourceY],
        hasEOL: false
      },
      items = [body, footer].map((r, index) => ({
        ...r,
        sourceItem: { pageNumber: number, index, text: r.str }
      })),
      viewport = {
        width: 600,
        height: 800,
        rotation: 0,
        scale: 1,
        transform: [1, 0, 0, -1, 0, 800],
        convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
      },
      fnArray: number[] = [],
      argsArray: unknown[] = [],
      add = (op: number, args: unknown): void => {
        fnArray.push(op)
        argsArray.push(args)
      }
    for (const [index, r] of items.entries()) {
      add(OPS.beginText, null)
      add(OPS.setFont, ['Old', 10])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, r.transform[4], index ? y : r.transform[5]]])
      add(OPS.showText, [
        Array.from(r.str).map((c) => ({
          unicode: c,
          fontChar: c,
          width: 500,
          isInFont: true,
          isSpace: false
        }))
      ])
      add(OPS.endText, null)
    }
    if (fault === 'rule-in-margin') {
      add(OPS.constructPath, [OPS.stroke, [new Float32Array([0, 40, 50, 1, 550, 50])], null])
    }
    const page = {
        pageNumber: number,
        width: 600,
        height: 800,
        rotation: 0,
        invalidGraphicsBounds: 0,
        graphicsBounds: []
      },
      context = {
        pageNumber: number,
        sourceSha256: 'a'.repeat(64),
        viewport,
        content: { items, styles: { Old: style } },
        operators: { fnArray, argsArray },
        graphicsBounds: [],
        glyphBounds: [
          {
            fontName: 'Old',
            glyphs: ['X', '1', '2', '3', '4'].map((c) => ({
              fontChar: c,
              bounds: [0, -0.1, 0.5, 0.7]
            }))
          }
        ]
      },
      nativeContent = {
        items: items.map((i) => ({ ...i, fontName: currentFont })),
        styles: { [currentFont]: style }
      },
      nativePage = {
        pageNumber: number,
        commonObjs: fault === 'different-task' && number === 13 ? { ...objects } : objects
      }
    if (fault === 'style-alias-mismatch' && number === 13)
      nativeContent.styles[currentFont] = { ...style, descent: -0.3 }
    if (fault === 'wrong-source' && number === 13) context.sourceSha256 = 'b'.repeat(64)
    if (fault === 'missing-glyph-bounds' && number === 13) context.glyphBounds = []
    frames.push(frame(page, context, { nativePage, nativeContent }))
    if (number === 12) {
      middle = { page, context }
      contextMutation = (): void => {
        fnArray.push(OPS.beginText)
        argsArray.push(null)
      }
    }
  }
  const table = {
    id: 'anonymous-table',
    issues: [],
    grid: [['X', '12']],
    cells: [
      { text: 'X', sourceItems: [{ pageNumber: 12, index: 0, text: 'X' }] },
      { text: '12', sourceItems: [{ pageNumber: 12, index: 1, text: '12' }] }
    ]
  }
  if (fault === 'no-native-claim') table.cells[1].sourceItems[0].index = 0
  expect(
    claim(table, (middle as { page: unknown }).page, (middle as { context: unknown }).context) !==
      undefined
  ).toBe(!['no-native-claim', 'body-number'].includes(fault))
  return {
    frames,
    table,
    mutateContext: (): void => {
      contextMutation?.()
    },
    mutateBuffer: (): void => {
      Object.defineProperty(font, 'data', { value: new Uint8Array(font.data) })
    },
    mutate: (): void => {
      font.data[0] = 255
    }
  }
}

it.each(['', 'undeclared-remeasure', 'fresh-view'])(
  'pauses only the table which actually claims a complete independent running folio: %s',
  (fault) => {
    const f = fixture(fault),
      before = structuredClone(f.table),
      after = review(f.table, f.frames[1], [f.frames[0], f.frames[2]])
    expect(after).toEqual({
      ...before,
      issues: ['native-table-structure-ambiguous'],
      review: false
    })
    expect(f.table).toEqual(before)
    const other = {
      ...before,
      cells: [{ text: 'X', sourceItems: [{ pageNumber: 12, index: 0, text: 'X' }] }]
    }
    expect(review(other, f.frames[1], [f.frames[0], f.frames[2]])).toBeUndefined()
  }
)

it.each([
  'wrong-number',
  'different-program',
  'different-task',
  'body-number',
  'foreign-margin-glyph',
  'rule-in-margin',
  'no-native-claim',
  'style-alias-mismatch',
  'wrong-source',
  'missing-glyph-bounds',
  'remeasure',
  'unknown-vertical',
  'changing-buffer'
])('does not infer page-control ownership from a number or incomplete evidence: %s', (fault) => {
  const f = fixture(fault)
  expect(review(f.table, f.frames[1], [f.frames[0], f.frames[2]])).toBeUndefined()
})

it('requires both native neighbor witnesses and unchanged loaded font bytes', () => {
  const f = fixture()
  expect(review(f.table, f.frames[1], [f.frames[0]])).toBeUndefined()
  f.mutate()
  expect(review(f.table, f.frames[1], [f.frames[0], f.frames[2]])).toBeUndefined()
  const changed = fixture()
  changed.mutateContext()
  expect(
    review(changed.table, changed.frames[1], [changed.frames[0], changed.frames[2]])
  ).toBeUndefined()
  const sameBytesNewBuffer = fixture()
  sameBytesNewBuffer.mutateBuffer()
  expect(
    review(sameBytesNewBuffer.table, sameBytesNewBuffer.frames[1], [
      sameBytesNewBuffer.frames[0],
      sameBytesNewBuffer.frames[2]
    ])
  ).toBeUndefined()
})

it('permits empty grid placeholders without granting any unclaimed nonempty cell', () => {
  const f = fixture(),
    before = { ...f.table, cells: [...(f.table.cells as unknown[]), { text: '' }] }
  expect(review(before, f.frames[1], [f.frames[0], f.frames[2]])).toEqual({
    ...before,
    issues: ['native-table-structure-ambiguous'],
    review: false
  })
  const incomplete = { ...f.table, cells: [...(f.table.cells as unknown[]), { text: 'X' }] }
  expect(review(incomplete, f.frames[1], [f.frames[0], f.frames[2]])).toBeUndefined()
})

it('declines accessor claims without executing them and does not interchange neighboring pages', () => {
  const f = fixture()
  let reads = 0
  const cells = f.table.cells
  Object.defineProperty(f.table, 'cells', {
    get: (): unknown => {
      reads++
      return cells
    }
  })
  expect(review(f.table, f.frames[1], [f.frames[0], f.frames[2]])).toBeUndefined()
  expect(reads).toBe(0)
  const ordinary = fixture()
  expect(
    review(ordinary.table, ordinary.frames[1], [ordinary.frames[2], ordinary.frames[0]])
  ).toBeUndefined()
})
