import { formPage } from '../support/form-page.js'
import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createCanvas } from '@napi-rs/canvas'
import {
  createAuxiliaryNativeExclusionReader,
  createNativeInkReader,
  createAuxiliaryNativeNegativeReader
} from '../../src/reader/auxiliary-native-ink.js'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import * as hardFormModule from '../../src/reader/native-form-clipped-text.js'
import { nativeAlgorithmInkRegions } from '../../src/reader/native-source-geometry.js'
import {
  readNativeFormClippedText,
  isNativeFormBBoxExclusion
} from '../../src/reader/native-form-clipped-text.js'
import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'

it('excludes only the complete clipped occurrence and accounts visible repeated text', async () => {
  const document = await formPage()
  try {
    const result = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    expect(result.coverage.exclusions).toEqual([
      { reason: 'occluded-native-text', items: [{ pageNumber: 1, index: 0, text: 'Panel label' }] }
    ])
    expect(result.coverage.includedItemCount).toBe(2)
    expect(result.coverage.textItemCount).toBe(3)
    expect(
      result.source.units.flatMap((u) => u.fragments.flatMap((f) => f.items.map((i) => i.index)))
    ).toEqual([1, 2])
  } finally {
    await document.destroy()
  }
})

it.each(['nested', 'repeated-form'])(
  'preserves occurrence-specific ancestor clips: %s',
  async (fault) => {
    const document = await formPage(fault)
    try {
      const page = await document.getPage(1),
        content = await getPdfTranslationTextContent(page),
        proof = await readNativeFormClippedText(page, content, page.getViewport({ scale: 1 }))
      expect([...(proof?.indexes ?? [])]).toEqual(fault === 'nested' ? [0] : [0, 1])
    } finally {
      await document.destroy()
    }
  }
)

it.each(['white', 'visible', 'partial', 'no-clip', 'path-clip', 'rotation', 'same-position'])(
  'retains sources without unique whole black ink outside a Form clip: %s',
  async (fault) => {
    const document = await formPage(fault)
    try {
      const page = await document.getPage(1),
        content = await getPdfTranslationTextContent(page)
      expect(
        await readNativeFormClippedText(page, content, page.getViewport({ scale: 1 }))
      ).toBeUndefined()
    } finally {
      await document.destroy()
    }
  }
)

it.each(['source', 'advance', 'position', 'type3', 'missing-outline', 'alpha', 'optional-content'])(
  'abstains on incomplete or unproved native occurrence evidence: %s',
  async (fault) => {
    const document = await formPage()
    try {
      const page = await document.getPage(1),
        content = await getPdfTranslationTextContent(page),
        viewport = page.getViewport({ scale: 1 }),
        operators = await page.getOperatorList(),
        item = content.items[0]
      if (!('str' in item)) throw Error('Missing source')
      if (fault === 'source') item.str = 'Different label'
      if (fault === 'advance') item.width += 1
      if (fault === 'position') item.transform[4] += 1
      if (fault === 'type3')
        Object.defineProperty(page.commonObjs.get(item.fontName), 'isType3Font', {
          value: true,
          configurable: true
        })
      if (fault === 'missing-outline') {
        const has = page.commonObjs.has.bind(page.commonObjs)
        page.commonObjs.has = (key: string) => !key.includes('_path_') && has(key)
      }
      if (fault === 'alpha' || fault === 'optional-content') {
        operators.fnArray.unshift(fault === 'alpha' ? OPS.setGState : OPS.beginMarkedContentProps)
        operators.argsArray.unshift(fault === 'alpha' ? [[['ca', 0]]] : ['OC', {}])
      }
      expect(await readNativeFormClippedText(page, content, viewport)).toBeUndefined()
    } finally {
      await document.destroy()
    }
  }
)

it.each(['source', 'operator', 'font', 'outline'])(
  'keeps the accepted exclusion bound to native object and byte lifetime: %s',
  async (fault) => {
    const document = await formPage()
    try {
      const page = await document.getPage(1),
        content = await getPdfTranslationTextContent(page),
        operators = await page.getOperatorList(),
        item = content.items[0]
      if (!('str' in item)) throw Error('Missing source')
      const proof = await readNativeFormClippedText(page, content, page.getViewport({ scale: 1 }))
      expect(proof?.indexes.has(0)).toBe(true)
      expect(proof?.current()).toBe(true)
      if (fault === 'source') item.str += '!'
      if (fault === 'operator')
        operators.argsArray[operators.fnArray.indexOf(OPS.paintFormXObjectBegin)][1][1] -= 1
      if (fault === 'font') page.commonObjs.get(item.fontName).data[0] ^= 1
      if (fault === 'outline') {
        const show = operators.argsArray[operators.fnArray.indexOf(OPS.showText)][0],
          glyph = show.find((g: unknown) => typeof g !== 'number'),
          path = page.commonObjs.get(`${item.fontName}_path_${glyph.fontChar}`).path
        path[1] += 1
      }
      expect(proof?.current()).toBe(false)
    } finally {
      await document.destroy()
    }
  }
)

it.each(['opaque', 'alpha', 'blend', 'mask', 'extra', 'prior-unknown'])(
  'recognizes only the complete opaque default graphics state: %s',
  async (fault) => {
    const document = await formPage()
    try {
      const page = await document.getPage(1),
        content = await getPdfTranslationTextContent(page),
        operators = await page.getOperatorList(),
        values: unknown[][] = [
          ['BM', 'source-over'],
          ['CA', 1],
          ['ca', 1]
        ]
      if (fault === 'alpha') values[2][1] = 0.5
      if (fault === 'blend') values[0][1] = 'multiply'
      if (fault === 'mask') values.push(['SMask', false])
      if (fault === 'extra') values.push(['LW', 1])
      operators.fnArray.unshift(OPS.setGState)
      operators.argsArray.unshift([values])
      if (fault === 'prior-unknown') {
        operators.fnArray.unshift(OPS.setGState)
        operators.argsArray.unshift([[['ca', 0.5]]])
      }
      const proof = await readNativeFormClippedText(page, content, page.getViewport({ scale: 1 }))
      expect([...(proof?.indexes ?? [])]).toEqual(fault === 'opaque' ? [0] : [])
      if (proof) {
        expect(proof.current()).toBe(true)
        values[2][1] = 0.5
        expect(proof.current()).toBe(false)
      }
    } finally {
      await document.destroy()
    }
  }
)

it('retains an item whose glyph ink enters the clip despite an outside metric box', async () => {
  const document = await formPage()
  try {
    const page = await document.getPage(1),
      content = await getPdfTranslationTextContent(page),
      operators = await page.getOperatorList(),
      item = content.items[0]
    if (!('str' in item)) throw Error('Missing source')
    const glyph = operators.argsArray[operators.fnArray.indexOf(OPS.showText)][0][0],
      outline = page.commonObjs.get(`${item.fontName}_path_${glyph.fontChar}`)
    Object.defineProperty(outline, 'path', {
      value: new Float32Array([0, 0, 0, 1, 0.5, 0, 1, 0.5, 3, 1, 0, 3, 4]),
      configurable: true
    })
    expect(
      await readNativeFormClippedText(page, content, page.getViewport({ scale: 1 }))
    ).toBeUndefined()
  } finally {
    await document.destroy()
  }
})

it('abstains when outline bytes change during asynchronous page verification', async () => {
  const document = await formPage()
  try {
    const page = await document.getPage(1),
      content = await getPdfTranslationTextContent(page),
      operators = await page.getOperatorList(),
      item = content.items[0]
    if (!('str' in item)) throw Error('Missing source')
    const glyph = operators.argsArray[operators.fnArray.indexOf(OPS.showText)][0][0],
      path = page.commonObjs.get(`${item.fontName}_path_${glyph.fontChar}`).path,
      get = page.getOperatorList.bind(page)
    let reads = 0
    page.getOperatorList = async (...args) => {
      const result = await get(...args)
      if (++reads === 2) path[1] += 1
      return result
    }
    expect(
      await readNativeFormClippedText(page, content, page.getViewport({ scale: 1 }))
    ).toBeUndefined()
  } finally {
    await document.destroy()
  }
})

async function formWithoutPrimaryOutlines(
  fault = '',
  renderFirst = false
): Promise<{
  document: PDFDocumentProxy
  primary: PDFDocumentProxy
  page: PDFPageProxy
  content: Awaited<ReturnType<typeof getPdfTranslationTextContent>>
  sourceIdentity: { sourceChecksum: string; sourceSizeBytes: number }
  request: Parameters<
    ReturnType<typeof createAuxiliaryNativeExclusionReader>['readNegativeExclusions']
  >[0]
}> {
  const document = await formPage(fault, false)
  let page = await document.getPage(1)
  if (renderFirst) {
    const viewport = page.getViewport({ scale: 1 }),
      canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
      viewport
    }).promise
  }
  const content = await getPdfTranslationTextContent(page),
    operators = await page.getOperatorList()
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  let font = ''
  const keys = new Set<string>()
  for (const [index, op] of operators.fnArray.entries()) {
    const args = operators.argsArray[index]
    if (op === OPS.setFont) font = args[0]
    if (op === OPS.showText)
      for (const glyph of args[0])
        if (typeof glyph?.fontChar === 'string') keys.add(font + '_path_' + glyph.fontChar)
  }
  // A Node loading task materializes paths even with font faces enabled. Hide
  // only that primary cache capability; all positive glyph evidence is re-read
  // from the real, byte-bound auxiliary and physically rendered below.
  const stableProxy = <T extends object>(value: T, overrides: Record<string, unknown>): T => {
    const bound = new Map<PropertyKey, unknown>()
    return new Proxy(value, {
      get(target, key) {
        if (typeof key === 'string' && key in overrides) return overrides[key]
        const item = Reflect.get(target, key, target)
        if (typeof item !== 'function') return item
        if (!bound.has(key)) bound.set(key, item.bind(target))
        return bound.get(key)
      }
    })
  }
  const objects = page.commonObjs
  page = stableProxy(page, {
    commonObjs: stableProxy(objects, {
      has: (key: string) => !key.includes('_path_') && objects.has(key)
    })
  })
  const primary = stableProxy(document, {
    getPage: async (number: number) => (number === 1 ? page : document.getPage(number))
  })
  expect(keys.size).toBeGreaterThan(0)
  expect([...keys].filter((key) => page.commonObjs.has(key))).toHaveLength(0)
  expect(
    await readNativeFormClippedText(page, content, page.getViewport({ scale: 1 }))
  ).toBeUndefined()
  const bytes = await document.getData(),
    sourceIdentity = {
      sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
      sourceSizeBytes: bytes.length
    }
  return {
    document,
    primary,
    page,
    content,
    sourceIdentity,
    request: {
      page,
      content,
      viewport: page.getViewport({ scale: 1 }),
      pageNumber: 1,
      operatorSnapshot: structuredClone(operators),
      selected: new Set(
        content.items.flatMap((item, index) => ('str' in item && item.str.trim() ? [index] : []))
      )
    }
  }
}

it('excludes hidden Form text through a bound auxiliary when the primary outline cache is unavailable', async () => {
  const { document, primary, sourceIdentity } = await formWithoutPrimaryOutlines()
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
  const factory = vi.fn(getDocument)
  try {
    const result = await extractPdfTranslationSource({
      document: primary,
      resourceRequestKey: 'anonymous-browser-font',
      sourceIdentity,
      nativeDocumentFactory: factory,
      signal: new AbortController().signal
    })
    expect(factory).toHaveBeenCalledOnce()
    expect(result.coverage.exclusions).toEqual([
      { reason: 'occluded-native-text', items: [{ pageNumber: 1, index: 0, text: 'Panel label' }] }
    ])
    expect(result.coverage.includedItemCount).toBe(2)
    const included = result.source.units.flatMap((unit) =>
      unit.fragments.flatMap((fragment) => fragment.items.map((item) => item.index))
    )
    expect(included).toEqual([1, 2])
    expect(new Set(included).size).toBe(included.length)
    expect(document.fingerprints[0]).toBeTruthy()
  } finally {
    vi.unstubAllGlobals()
    await document.destroy()
  }
})

it.each([
  'primary font',
  'auxiliary font',
  'source identity',
  'operator program',
  'operator snapshot',
  'source literal',
  'selected subset',
  'cache viewport',
  'abort',
  'dispose',
  'published indexes'
])('refuses stale or unauthorized auxiliary exclusions: %s', async (fault) => {
  const { document, primary, sourceIdentity, request } = await formWithoutPrimaryOutlines()
  const controller = new AbortController()
  let auxiliary: PDFDocumentProxy | undefined
  const factory = (options: Parameters<typeof getDocument>[0]): ReturnType<typeof getDocument> => {
    const task = getDocument(options)
    void task.promise.then((value) => {
      auxiliary = value
    })
    return task
  }
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
  const reader = createAuxiliaryNativeExclusionReader(
    {
      document: primary,
      sourceIdentity,
      nativeDocumentFactory: factory,
      signal: controller.signal
    },
    readNativeFormClippedText
  )
  let restore: () => void = () => undefined
  try {
    if (fault === 'selected subset') {
      expect(
        await reader.readNegativeExclusions({ ...request, selected: new Set([1, 2]) })
      ).toBeUndefined()
      return
    }
    const proof = await reader.readNegativeExclusions(request)
    expect(proof?.negativeOnly).toBe(true)
    expect([...proof!.indexes]).toEqual([0])
    expect(proof!.current()).toBe(true)
    if (fault.endsWith('font')) {
      const page = fault === 'primary font' ? request.page : await auxiliary!.getPage(1)
      const content = await getPdfTranslationTextContent(page)
      const item = content.items.find((item) => 'str' in item && item.str.trim())!
      const font = page.commonObjs.get('fontName' in item ? item.fontName : '')
      const before = font.data[0]
      font.data[0] ^= 1
      restore = () => {
        font.data[0] = before
      }
    } else if (fault === 'source identity') {
      const before = sourceIdentity.sourceChecksum
      sourceIdentity.sourceChecksum = 'f'.repeat(64)
      restore = () => {
        sourceIdentity.sourceChecksum = before
      }
    } else if (fault === 'operator program' || fault === 'operator snapshot') {
      const operators =
        fault === 'operator program'
          ? await request.page.getOperatorList()
          : request.operatorSnapshot!
      const at = operators.fnArray.indexOf(OPS.showText)
      const glyph = operators.argsArray[at][0].find((part: unknown) => typeof part === 'object')
      const before = glyph.width
      glyph.width += 1
      restore = () => {
        glyph.width = before
      }
    } else if (fault === 'source literal') {
      const item = request.content.items[0]
      if (!('str' in item)) throw new Error('Missing fixture text')
      const before = item.str
      item.str = 'Changed literal'
      restore = () => {
        item.str = before
      }
    } else if (fault === 'cache viewport') {
      const before = request.viewport.transform[4]
      request.viewport.transform[4] += 1
      restore = () => {
        request.viewport.transform[4] = before
      }
    } else if (fault === 'abort') controller.abort()
    else if (fault === 'dispose') await reader.dispose()
    else (proof!.indexes as Set<number>).add(1)
    expect(proof!.current()).toBe(false)
    if (fault !== 'published indexes')
      expect(await reader.readNegativeExclusions(request)).toBeUndefined()
  } finally {
    restore()
    await reader.dispose()
    vi.unstubAllGlobals()
    await document.destroy()
  }
})

it('excludes only hard Form-clipped text after real image rendering before the first native operator request', async () => {
  const { document, primary, sourceIdentity, request } = await formWithoutPrimaryOutlines(
    'images',
    true
  )
  const originalOps = await request.page.getOperatorList()
  expect(originalOps.fnArray.filter((op) => op === OPS.paintImageXObject)).toHaveLength(2)
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
  try {
    const result = await extractPdfTranslationSource({
      document: primary,
      resourceRequestKey: 'anonymous-render-first',
      sourceIdentity,
      nativeDocumentFactory: getDocument,
      signal: new AbortController().signal
    })
    expect(
      result.coverage.exclusions.flatMap((entry) => entry.items.map((item) => item.index))
    ).toEqual([0])
    expect(
      result.source.units.flatMap((unit) =>
        unit.fragments.flatMap((fragment) => fragment.items.map((item) => [item.index, item.text]))
      )
    ).toEqual([
      [1, 'Panel label'],
      [2, 'Visible caption']
    ])
  } finally {
    vi.unstubAllGlobals()
    await document.destroy()
  }
})

it.each([
  'alias-not-bijective',
  'dependency-mismatch',
  'dependency-missing',
  'dimensions',
  'transform',
  'clip',
  'font-program',
  'repeat'
])('does not authorize image allocator aliases across a changed %s', async (fault) => {
  const { document, primary, sourceIdentity, request } = await formWithoutPrimaryOutlines(
    'images',
    true
  )
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
  const baseline = createAuxiliaryNativeExclusionReader(
    { document: primary, sourceIdentity, nativeDocumentFactory: getDocument },
    readNativeFormClippedText
  )
  try {
    const proof = await baseline.readNegativeExclusions(request)
    expect([...proof!.indexes]).toEqual([0])
    expect(proof!.current()).toBe(true)
  } finally {
    await baseline.dispose()
  }
  const ops = await request.page.getOperatorList(),
    before = structuredClone(ops)
  const images = ops.fnArray.flatMap((op, index) => (op === OPS.paintImageXObject ? [index] : []))
  const first = images[0],
    second = images[1]
  expect(ops.fnArray[first - 1]).toBe(OPS.dependency)
  let restoreFont: () => void = () => undefined
  if (fault === 'alias-not-bijective') ops.argsArray[first][0] = ops.argsArray[second][0]
  if (fault === 'dependency-mismatch') ops.argsArray[first - 1][0] = 'img_p0_999'
  if (fault === 'dependency-missing') ops.argsArray[first - 1][0] = 'unrecognized-resource'
  if (fault === 'dimensions') ops.argsArray[first][1] += 1
  if (fault === 'transform') {
    const at = ops.fnArray.indexOf(OPS.transform)
    ops.argsArray[at][0] += 0.1
  }
  if (fault === 'clip') {
    const at = ops.fnArray.indexOf(OPS.paintFormXObjectBegin)
    ops.argsArray[at][1][1] += 1
  }
  if (fault === 'repeat') ops.fnArray[first] = OPS.paintImageXObjectRepeat
  if (fault === 'font-program') {
    const item = request.content.items.find((item) => 'str' in item && item.str.trim())!
    const font = request.page.commonObjs.get('fontName' in item ? item.fontName : '')
    const value = font.data[0]
    font.data[0] ^= 1
    restoreFont = () => {
      font.data[0] = value
    }
  }
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
  const reader = createAuxiliaryNativeExclusionReader(
    { document: primary, sourceIdentity, nativeDocumentFactory: getDocument },
    readNativeFormClippedText
  )
  try {
    expect(
      await reader.readNegativeExclusions({ ...request, operatorSnapshot: structuredClone(ops) })
    ).toBeUndefined()
  } finally {
    try {
      await reader.dispose()
    } finally {
      ops.fnArray.splice(0, ops.fnArray.length, ...before.fnArray)
      ops.argsArray.splice(0, ops.argsArray.length, ...before.argsArray)
      restoreFont()
      vi.unstubAllGlobals()
      await document.destroy()
    }
  }
})

it.each(['positive ink', 'exact-selected ink', 'generic exclusion'])(
  'keeps %s strict when only image allocator labels differ',
  async (mode) => {
    const { document, primary, sourceIdentity, request } = await formWithoutPrimaryOutlines(
      'images',
      true
    )
    const factory = vi.fn(getDocument),
      options = { document: primary, sourceIdentity, nativeDocumentFactory: factory }
    vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
    const readInk = vi.fn(nativeAlgorithmInkRegions),
      readExcluded = vi.fn(readNativeFormClippedText)
    const reader =
      mode === 'positive ink'
        ? createNativeInkReader(options, readInk)
        : mode === 'exact-selected ink'
          ? createAuxiliaryNativeNegativeReader(options, readInk)
          : createAuxiliaryNativeExclusionReader(options, readExcluded)
    try {
      const result =
        'read' in reader
          ? await reader.read(request)
          : 'readNegativeSelection' in reader
            ? await reader.readNegativeSelection(request)
            : await reader.readNegativeExclusions(request)
      expect(result).toBeUndefined()
      expect(factory).toHaveBeenCalledOnce()
      if (mode !== 'generic exclusion') expect(readInk).toHaveBeenCalledOnce()
      if (mode === 'generic exclusion') expect(readExcluded).toHaveBeenCalledOnce()
    } finally {
      await reader.dispose()
      vi.unstubAllGlobals()
      await document.destroy()
    }
  }
)

it('requires the original hard Form proof rather than a matching kind field or copied proof', async () => {
  const document = await formPage()
  try {
    const page = await document.getPage(1),
      content = await getPdfTranslationTextContent(page)
    const proof = await readNativeFormClippedText(page, content, page.getViewport({ scale: 1 }))
    expect(isNativeFormBBoxExclusion(proof)).toBe(true)
    expect(isNativeFormBBoxExclusion({ ...proof })).toBe(false)
    expect(
      isNativeFormBBoxExclusion(proof, { page, content, viewport: page.getViewport({ scale: 1 }) })
    ).toBe(false)
    const selected = proof!.indexes as Set<number>
    selected.add(1)
    expect(isNativeFormBBoxExclusion(proof)).toBe(false)
    expect(proof!.current()).toBe(false)
    selected.delete(1)

    expect(
      isNativeFormBBoxExclusion({
        kind: 'hard-form-bbox',
        indexes: new Set([0]),
        current: () => true
      })
    ).toBe(false)
  } finally {
    await document.destroy()
  }
})

it('keeps original operator identities current after hard Form image-name comparison', async () => {
  const { document, primary, sourceIdentity, request } = await formWithoutPrimaryOutlines(
    'images',
    true
  )
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
  const reader = createAuxiliaryNativeExclusionReader(
    { document: primary, sourceIdentity, nativeDocumentFactory: getDocument },
    readNativeFormClippedText
  )
  const ops = await request.page.getOperatorList(),
    at = ops.fnArray.indexOf(OPS.paintImageXObject),
    before = ops.argsArray[at][0]
  try {
    const proof = await reader.readNegativeExclusions(request)
    expect(proof?.current()).toBe(true)
    expect([...proof!.indexes]).toEqual([0])
    expect('items' in proof!).toBe(false)
    expect('read' in reader).toBe(false)
    ops.argsArray[at][0] = 'img_p0_999'
    expect(proof!.current()).toBe(false)
    expect(await reader.readNegativeExclusions(request)).toBeUndefined()
  } finally {
    ops.argsArray[at][0] = before
    await reader.dispose()
    vi.unstubAllGlobals()
    await document.destroy()
  }
})

it('rejects an unbranded kind through the direct producer slot without image alias differences', async () => {
  const { document, primary, sourceIdentity, request } = await formWithoutPrimaryOutlines()
  const fake = Object.freeze({
    kind: 'hard-form-bbox' as const,
    indexes: new Set([0]),
    current: () => true
  })
  const spy = vi
    .spyOn(hardFormModule, 'readNativeFormClippedText')
    .mockImplementation(async (page) => (page === request.page ? undefined : fake))
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
  const reader = createAuxiliaryNativeExclusionReader(
    { document: primary, sourceIdentity, nativeDocumentFactory: getDocument },
    hardFormModule.readNativeFormClippedText
  )
  try {
    expect(await reader.readNegativeExclusions(request)).toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(2)
  } finally {
    await reader.dispose()
    spy.mockRestore()
    vi.unstubAllGlobals()
    await document.destroy()
  }
})
