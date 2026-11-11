import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { PDFDocument, degrees } from 'pdf-lib'
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFPageProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'
import {
  readNativeType3Navigation,
  readOutlierFontNavigation
} from '../../src/reader/outlier-font-navigation.js'

type Fixture = {
  font: Record<string, unknown>
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
  viewport: ReturnType<PDFPageProxy['getViewport']>
}
let sharedTask: ReturnType<typeof getDocument>, shared: Fixture

async function anonymousOutlierDocument(): Promise<ReturnType<typeof getDocument>> {
  const bytes = new Uint8Array(
    await readFile(
      join(
        dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
        'standard_fonts/LiberationSans-Regular.ttf'
      )
    )
  )
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < data.getUint16(4); i++) {
    const record = 12 + i * 16
    if (String.fromCharCode(...bytes.slice(record, record + 4)) === 'hhea') {
      data.setInt16(data.getUint32(record + 8) + 4, 2400)
    }
  }
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(bytes, { subset: false })
  pdf.addPage([600, 800]).drawText('Tilted label', {
    x: 200,
    y: 400,
    size: 10,
    rotate: degrees(30),
    font
  })
  return getDocument({
    data: await pdf.save(),
    fontExtraProperties: true,
    disableFontFace: false,
    isEvalSupported: false,
    verbosity: 0
  })
}

beforeAll(async (): Promise<void> => {
  sharedTask = await anonymousOutlierDocument()
  const document = await sharedTask.promise,
    page = await document.getPage(1),
    content = await getPdfTranslationTextContent(page)
  await page.getOperatorList()
  const item = content.items[0] as TextItem,
    font = page.commonObjs.get(item.fontName)
  shared = {
    content,
    viewport: page.getViewport({ scale: 1 }),
    font: Object.fromEntries(
      [
        'type',
        'loadedName',
        'vertical',
        'missingFile',
        'isInvalidPDFjsFont',
        'isType3Font',
        'remeasure',
        'data',
        'fontMatrix',
        'bbox',
        'ascent',
        'descent'
      ].map((key) => [key, font[key]])
    )
  }
})

afterAll(async (): Promise<void> => {
  await sharedTask?.destroy()
})

function readFixture(
  fixture: Fixture
): ReadonlyMap<number, { x: number; y: number; width: number; height: number }> {
  return readOutlierFontNavigation(
    {
      commonObjs: { has: (): boolean => true, get: (): unknown => fixture.font }
    } as unknown as PDFPageProxy,
    fixture.content,
    fixture.viewport
  )
}

function tableOffset(bytes: Uint8Array, name: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16
    if (String.fromCharCode(...bytes.subarray(record, record + 4)) === name) return record
  }
  throw Error('Missing anonymous font table')
}

type Fault =
  | 'missing-program'
  | 'missing-file'
  | 'undefined-missing-file'
  | 'invalid-font'
  | 'type3'
  | 'undefined-type3'
  | 'remeasure'
  | 'loaded-name'
  | 'matrix'
  | 'style-mismatch'
  | 'vertical'
  | 'shear'
  | 'reflected'
  | 'outside-page'
  | 'nonfinite-width'
  | 'orthogonal'
  | 'truncated-program'
  | 'duplicate-table'
  | 'overlapping-table'
  | 'table-overflow'
  | 'zero-units'
  | 'head-version'
  | 'head-magic'
  | 'hhea-version'
  | 'hhea-mismatch'
  | 'glyph-overflow'
  | 'loca-overflow'

it.each<Fault>([
  'missing-program',
  'missing-file',
  'undefined-missing-file',
  'invalid-font',
  'type3',
  'undefined-type3',
  'remeasure',
  'loaded-name',
  'matrix',
  'style-mismatch',
  'vertical',
  'shear',
  'reflected',
  'outside-page',
  'nonfinite-width',
  'orthogonal',
  'truncated-program',
  'duplicate-table',
  'overlapping-table',
  'table-overflow',
  'zero-units',
  'head-version',
  'head-magic',
  'hhea-version',
  'hhea-mismatch',
  'glyph-overflow',
  'loca-overflow'
])('retains the existing exclusion when native proof has %s', (fault): void => {
  const f = structuredClone(shared),
    item = f.content.items[0] as TextItem,
    style = f.content.styles[item.fontName],
    bytes = f.font.data as Uint8Array,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    head = view.getUint32(tableOffset(bytes, 'head') + 8),
    hhea = view.getUint32(tableOffset(bytes, 'hhea') + 8),
    maxp = view.getUint32(tableOffset(bytes, 'maxp') + 8),
    loca = view.getUint32(tableOffset(bytes, 'loca') + 8)
  if (fault === 'missing-program') delete f.font.data
  if (fault === 'missing-file') f.font.missingFile = true
  if (fault === 'undefined-missing-file') delete f.font.missingFile
  if (fault === 'invalid-font') f.font.isInvalidPDFjsFont = true
  if (fault === 'type3') f.font.isType3Font = true
  if (fault === 'undefined-type3') delete f.font.isType3Font
  if (fault === 'remeasure') f.font.remeasure = true
  if (fault === 'loaded-name') f.font.loadedName = 'another-font'
  if (fault === 'matrix') (f.font.fontMatrix as number[])[1] = 0.1
  if (fault === 'style-mismatch') style.ascent += 0.1
  if (fault === 'vertical') style.vertical = true
  if (fault === 'shear') item.transform[2] += 1
  if (fault === 'reflected') {
    item.transform[2] *= -1
    item.transform[3] *= -1
  }
  if (fault === 'outside-page') item.transform[4] = -500
  if (fault === 'nonfinite-width') item.width = NaN
  if (fault === 'orthogonal') item.transform = [10, 0, 0, 10, 200, 400]
  if (fault === 'truncated-program') f.font.data = bytes.subarray(0, bytes.length - 16)
  if (fault === 'duplicate-table') bytes.set(bytes.subarray(12, 16), 28)
  if (fault === 'overlapping-table') view.setUint32(36, view.getUint32(20))
  if (fault === 'table-overflow') view.setUint32(20, 0xfffffffc)
  if (fault === 'zero-units') view.setUint16(head + 18, 0)
  if (fault === 'head-version') view.setUint32(head, 0x00020000)
  if (fault === 'head-magic') view.setUint32(head + 12, 0)
  if (fault === 'hhea-version') view.setUint32(hhea, 0)
  if (fault === 'hhea-mismatch') view.setInt16(hhea + 4, 2000)
  if (fault === 'glyph-overflow') view.setUint16(maxp + 4, 4097)
  if (fault === 'loca-overflow') view.setUint16(loca, 0xffff)
  expect(readFixture(f).size).toBe(0)
})

it('uses the native undefined remeasurement default without mutating shared style or font data', (): void => {
  const f = structuredClone(shared),
    item = f.content.items[0] as TextItem,
    style = f.content.styles[item.fontName],
    before = structuredClone(f)
  expect(f.font.remeasure).toBeUndefined()
  Object.freeze(style)
  Object.freeze(f.font)
  expect(readFixture(f).size).toBe(1)
  expect(f).toEqual(before)
})

it('retains missing optional native capabilities without a metric fallback', (): void => {
  const f = structuredClone(shared)
  const page = { commonObjs: {} } as unknown as PDFPageProxy
  expect(readOutlierFontNavigation(page, f.content, f.viewport).size).toBe(0)
  const content = { items: f.content.items } as typeof f.content
  expect(readOutlierFontNavigation(page, content, f.viewport).size).toBe(0)
  f.font.remeasure = 'enabled'
  expect(readFixture(f).size).toBe(0)
})

it('retains aborts occurring while the public extractor awaits the native page', async (): Promise<void> => {
  const document = await sharedTask.promise,
    controller = new AbortController()
  const pending = extractPdfTranslationSource({
    document: {
      numPages: document.numPages,
      fingerprints: document.fingerprints,
      getPage: async (number): Promise<PDFPageProxy> => {
        const page = await document.getPage(number)
        controller.abort()
        return page
      }
    },
    resourceRequestKey: 'anonymous',
    signal: controller.signal
  })
  await expect(pending).rejects.toThrow()
})

it('retains a complete embedded outlier-metric label as an independent original-only anchor', async (): Promise<void> => {
  const task = await anonymousOutlierDocument()
  try {
    const document = await task.promise
    const page = await document.getPage(1)
    const content = await page.getTextContent()
    expect(Object.values(content.styles)[0].ascent).toBeGreaterThan(1)
    const extraction = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    expect(extraction.coverage.excludedItemCount).toBe(0)
    expect(extraction.source.units).toHaveLength(1)
    expect(extraction.source.units[0]).toMatchObject({
      source: 'Tilted label',
      sourceOnly: true
    })
    expect(extraction.source.units[0].preserve).toBeUndefined()
    expect(extraction.source.originalRegions).toBeUndefined()
  } finally {
    await task.destroy()
  }
})

function type3Fixture(): {
  page: PDFPageProxy
  content: Fixture['content']
  viewport: Fixture['viewport']
  font: Record<string, unknown>
  program: { fnArray: number[]; argsArray: unknown[][] }
  operators: { fnArray: number[]; argsArray: unknown[][] }
} {
  const c = Math.cos(Math.PI / 6),
    s = Math.sin(Math.PI / 6)
  const matrix = [10 * c, 10 * s, -10 * s, 10 * c, 200, 400]
  const program = {
    fnArray: [OPS.setCharWidthAndBounds, OPS.constructPath],
    argsArray: [
      [600, 0, 0, -200, 600, 800],
      [OPS.fill, [new Float32Array([0, 0, -200, 1, 600, -200, 1, 600, 800, 1, 0, 800, 4])]]
    ]
  }
  const font = {
    isType3Font: true,
    missingFile: false,
    isInvalidPDFjsFont: false,
    remeasure: false,
    loadedName: 'native',
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    ascent: 0.8,
    descent: -0.2,
    charProcOperatorList: { eight: program }
  }
  const glyph = { unicode: '8', width: 600, isInFont: true, operatorListId: 'eight' }
  const operators = {
    fnArray: [
      OPS.beginText,
      OPS.setFont,
      OPS.setFillRGBColor,
      OPS.setTextMatrix,
      OPS.showText,
      OPS.endText
    ],
    argsArray: [[], ['native', 10], ['#000000'], [c, s, -s, c, 200, 400], [[glyph, glyph]], []]
  }
  const content = {
    items: [
      {
        str: '88',
        dir: 'ltr',
        width: 12,
        height: 10,
        transform: matrix,
        fontName: 'native',
        hasEOL: false
      }
    ],
    styles: { native: { fontFamily: 'native', ascent: 0.8, descent: -0.2 } },
    lang: null
  } as unknown as Fixture['content']
  return {
    content,
    font,
    program,
    operators,
    viewport: {
      width: 600,
      height: 800,
      rotation: 0,
      scale: 1,
      transform: [1, 0, 0, -1, 0, 800]
    } as Fixture['viewport'],
    page: {
      commonObjs: { has: () => true, get: () => font },
      getOperatorList: async () => operators
    } as unknown as PDFPageProxy
  }
}
const nativeType3 = (
  f: ReturnType<typeof type3Fixture>,
  signal = new AbortController().signal,
  current = (): boolean => true
): ReturnType<typeof readNativeType3Navigation> =>
  readNativeType3Navigation(f.page, f.content, f.viewport, { signal, current })

it('certifies original-only Type3 navigation from horizontal native programs without inventing a vertical flag', async () => {
  const f = type3Fixture(),
    before = structuredClone(f.content),
    proof = await nativeType3(f)
  expect(proof?.regions.size).toBe(1)
  expect(proof?.current()).toBe(true)
  expect(f.content).toEqual(before)
  expect('vertical' in f.font).toBe(false)
  expect('vertical' in f.content.styles.native).toBe(false)
})
it.each([
  'vertical',
  'vertical-program',
  'wrong-width',
  'wrong-literal',
  'invisible',
  'white',
  'partial-glyph'
] as const)('declines insufficient horizontal Type3 proof: %s', async (fault) => {
  const f = type3Fixture()
  if (fault === 'vertical') Object.assign(f.font, { vertical: true })
  if (fault === 'vertical-program') f.program.argsArray[0][1] = 1
  if (fault === 'wrong-width') f.program.argsArray[0][0] = 601
  if (fault === 'wrong-literal') (f.content.items[0] as TextItem).str = '89'
  if (fault === 'invisible') {
    f.operators.fnArray.splice(4, 0, OPS.setTextRenderingMode)
    f.operators.argsArray.splice(4, 0, [3])
  }
  if (fault === 'white') f.operators.argsArray[2][0] = '#ffffff'
  if (fault === 'partial-glyph') {
    for (const g of f.operators.argsArray[4][0] as Record<string, unknown>[]) g.unicode = '88'
    ;(f.content.items[0] as TextItem).str = '8'
  }
  expect(await nativeType3(f)).toBeUndefined()
})
it.each([
  'source-item',
  'source-transform',
  'style',
  'operator',
  'font',
  'program',
  'rectangle'
] as const)('rejects late equal replacement or changed native state: %s', async (fault) => {
  const f = type3Fixture(),
    proof = await nativeType3(f)
  expect(proof?.current()).toBe(true)
  if (fault === 'source-item') f.content.items[0] = { ...f.content.items[0] }
  if (fault === 'source-transform')
    (f.content.items[0] as TextItem).transform = [...(f.content.items[0] as TextItem).transform]
  if (fault === 'style') f.content.styles.native = { ...f.content.styles.native }
  if (fault === 'operator') f.operators.argsArray[4] = [...f.operators.argsArray[4]]
  if (fault === 'font')
    Object.defineProperty(f.page.commonObjs, 'get', { value: () => ({ ...f.font }) })
  if (fault === 'program') (f.program.argsArray[1][1] as Float32Array[])[0][2] = -201
  if (fault === 'rectangle') Object.assign(proof!.regions.get(0)!, { x: 0 })
  expect(proof?.current()).toBe(false)
})
it('accepts a stable native packed font matrix getter but seals its descriptor', async () => {
  const f = type3Fixture()
  delete (f.font as Partial<typeof f.font>).fontMatrix
  const prototype = {
    get fontMatrix(): number[] {
      return [0.001, 0, 0, 0.001, 0, 0]
    }
  }
  Object.setPrototypeOf(f.font, prototype)
  const proof = await nativeType3(f)
  expect(proof?.current()).toBe(true)
  Object.defineProperty(f.font, 'fontMatrix', { value: [0.001, 0, 0, 0.001, 0, 0] })
  expect(proof?.current()).toBe(false)
})
it('checks source epoch and abort after awaiting actual operators', async () => {
  const f = type3Fixture()
  let release: (value: typeof f.operators) => void = () => undefined
  f.page.getOperatorList = () =>
    new Promise((resolve) => {
      release = resolve
    }) as ReturnType<PDFPageProxy['getOperatorList']>
  const result = nativeType3(f)
  f.content.items[0] = { ...f.content.items[0] }
  release(f.operators)
  expect(await result).toBeUndefined()
  const controller = new AbortController(),
    g = type3Fixture()
  g.page.getOperatorList = (async () => {
    controller.abort()
    return g.operators
  }) as PDFPageProxy['getOperatorList']
  await expect(nativeType3(g, controller.signal)).rejects.toThrow()
  expect(await nativeType3(type3Fixture(), undefined, () => false)).toBeUndefined()
})

it.each(['complete', 'wrong-width', 'vertical-program', 'unproved-move', 'nonfinite'] as const)(
  'requires the exact native TJ advance for original-only Type3 navigation: %s',
  async (fault) => {
    const f = type3Fixture(),
      glyph = (f.operators.argsArray[4][0] as unknown[])[0]
    f.operators.argsArray[4][0] = [glyph, -100, glyph]
    ;(f.content.items[0] as TextItem).width = 13
    if (fault === 'wrong-width') (f.content.items[0] as TextItem).width = 12
    if (fault === 'vertical-program') f.program.argsArray[0][1] = 1
    if (fault === 'nonfinite') f.operators.argsArray[4][0] = [glyph, NaN, glyph]
    if (fault === 'unproved-move') {
      f.operators.fnArray.splice(4, 1, OPS.showText, OPS.moveText, OPS.showText)
      f.operators.argsArray.splice(4, 1, [[glyph]], [7, 0], [[glyph]])
    }
    const original = structuredClone(f.content),
      proof = await nativeType3(f)
    expect(proof?.regions.size).toBe(fault === 'complete' ? 1 : undefined)
    expect(f.content).toEqual(original)
    expect('vertical' in f.font).toBe(false)
    expect('vertical' in f.content.styles.native).toBe(false)
  }
)

it('revokes a Type3 navigation certificate after its actual TJ operand changes', async () => {
  const f = type3Fixture(),
    glyph = (f.operators.argsArray[4][0] as unknown[])[0]
  f.operators.argsArray[4][0] = [glyph, -100, glyph]
  ;(f.content.items[0] as TextItem).width = 13
  const proof = await nativeType3(f)
  expect(proof?.current()).toBe(true)
  ;(f.operators.argsArray[4][0] as unknown[])[1] = -101
  expect(proof?.current()).toBe(false)
})
