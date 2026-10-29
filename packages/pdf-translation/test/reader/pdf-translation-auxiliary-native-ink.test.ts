import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createAuxiliaryNativeInkReader } from '../../src/reader/auxiliary-native-ink.js'
import type { AuxiliaryNativeInkReader } from '../../src/reader/auxiliary-native-ink.js'
import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'
import { nativeAlgorithmInkRegions } from '../../src/reader/native-source-geometry.js'

type Request = Parameters<AuxiliaryNativeInkReader['read']>[0]
type Fixture = {
  task: ReturnType<typeof getDocument>
  document: Awaited<ReturnType<typeof getDocument>['promise']>
  request: Request
  identity: { sourceChecksum: string; sourceSizeBytes: number }
}
let task: ReturnType<typeof getDocument>,
  document: Awaited<ReturnType<typeof getDocument>['promise']>,
  request: Request,
  identity: { sourceChecksum: string; sourceSizeBytes: number }

async function anonymousDocument(width = 400): Promise<Fixture> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(
    await readFile(
      join(
        dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
        'standard_fonts/LiberationSans-Regular.ttf'
      )
    ),
    {
      subset: false
    }
  )
  const page = pdf.addPage([width, 500])
  page.drawText('Anonymous.', {
    x: 40,
    y: 440,
    size: 12,
    font
  })
  // Emit only the native text operators supported by the existing narrow core.
  const encoded = font.encodeText('Anonymous.').toString(),
    fontKey = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0].toString()
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(pdf.context.flateStream(`BT ${fontKey} 12 Tf 40 440 Td ${encoded} Tj ET`))
  )
  const data = await pdf.save()
  const identity = {
    sourceChecksum: createHash('sha256').update(data).digest('hex'),
    sourceSizeBytes: data.length
  }
  const task = getDocument({
      data: data.slice(),
      fontExtraProperties: true,
      isEvalSupported: false
    }),
    document = await task.promise
  const nativePage = await document.getPage(1),
    content = await getPdfTranslationTextContent(nativePage)
  const request = {
    page: nativePage,
    content,
    viewport: nativePage.getViewport({ scale: 1 }),
    pageNumber: 1,
    selected: new Set(
      content.items.flatMap((item, index): number[] =>
        'str' in item && item.str.trim() ? [index] : []
      )
    )
  }
  return { task, document, request, identity }
}

beforeAll(async () => {
  ;({ task, document, request, identity } = await anonymousDocument())
})

function publicProxy<T extends object>(value: T, overrides: Record<string, unknown>): T {
  return new Proxy(value, {
    get(target, key): unknown {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const item = Reflect.get(target, key, target)
      return typeof item === 'function' ? item.bind(target) : item
    }
  })
}

// Simulate only a missing cache capability for refusal/lifecycle tests. These
// controls never return positive glyph evidence or alter source/font/operator data.
function withoutOutlineCache(
  primary: Fixture['document'],
  input: Request
): {
  document: Fixture['document']
  request: Request
} {
  const objects = input.page.commonObjs,
    commonObjs = publicProxy(objects, {
      has: (key: string): boolean => !key.includes('_path_') && objects.has(key)
    }),
    page = publicProxy(input.page, { commonObjs })
  return {
    document: publicProxy(primary, {
      getPage: async (number: number): Promise<Request['page']> =>
        number === input.pageNumber ? page : primary.getPage(number)
    }),
    request: { ...input, page }
  }
}

afterAll(async () => {
  await task?.destroy()
})

it('keeps the existing native core and primary document when outlines are already complete', async () => {
  const native = await nativeAlgorithmInkRegions(
    request.page,
    request.content,
    request.viewport,
    request.pageNumber,
    request.selected
  )
  expect(native?.size).toBe(request.selected.size)
  const factory = vi.fn((): ReturnType<typeof getDocument> => {
    throw new Error('Unneeded auxiliary document.')
  })
  // Only the browser availability gate is provided; no canvas or font evidence is fabricated.
  vi.stubGlobal('document', { createElement: vi.fn() })
  const reader = createAuxiliaryNativeInkReader({
    document,
    nativeDocumentFactory: factory,
    sourceIdentity: identity
  })
  try {
    expect(await reader.read(request)).toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
    expect(
      createHash('sha256')
        .update(await document.getData())
        .digest('hex')
    ).toBe(identity.sourceChecksum)
  } finally {
    await reader.dispose()
    vi.unstubAllGlobals()
  }
})

it.each([
  'factory',
  'data API',
  'metadata API',
  'identity',
  'browser canvas',
  'aborted',
  'disposed'
])('requires explicit %s evidence before creating an auxiliary document', async (missing) => {
  const factory = vi.fn((): ReturnType<typeof getDocument> => {
      throw new Error('Unqualified auxiliary document.')
    }),
    controller = new AbortController()
  vi.stubGlobal('document', missing === 'browser canvas' ? undefined : { createElement: vi.fn() })
  if (missing === 'aborted') controller.abort()
  const primary = {
    getPage: document.getPage.bind(document),
    numPages: document.numPages,
    fingerprints: document.fingerprints,
    getData: missing === 'data API' ? undefined : document.getData.bind(document),
    getMetadata: missing === 'metadata API' ? undefined : document.getMetadata.bind(document)
  }
  const reader = createAuxiliaryNativeInkReader({
    document: primary,
    nativeDocumentFactory: missing === 'factory' ? undefined : factory,
    sourceIdentity: missing === 'identity' ? undefined : identity,
    signal: controller.signal
  })
  try {
    if (missing === 'disposed') await reader.dispose()
    expect(await reader.read(request)).toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
  } finally {
    await reader.dispose()
    vi.unstubAllGlobals()
  }
})

it.each(['page object', 'source literal', 'viewport', 'page number', 'selected origin'])(
  'refuses a changed primary %s before opening the auxiliary document',
  async (changed) => {
    const factory = vi.fn((): ReturnType<typeof getDocument> => {
      throw new Error('Unqualified auxiliary document.')
    })
    vi.stubGlobal('document', { createElement: vi.fn() })
    const reader = createAuxiliaryNativeInkReader({
      document,
      nativeDocumentFactory: factory,
      sourceIdentity: identity
    })
    let input = request
    if (changed === 'page object') input = { ...request, page: { ...request.page } }
    else if (changed === 'source literal')
      input = {
        ...request,
        content: {
          ...request.content,
          items: request.content.items.map((item): typeof item =>
            'str' in item ? { ...item, str: item.str + ' foreign' } : item
          )
        }
      }
    else if (changed === 'viewport')
      input = { ...request, viewport: request.page.getViewport({ scale: 1, offsetX: 1 }) }
    else if (changed === 'page number') input = { ...request, pageNumber: 2 }
    else input = { ...request, selected: new Set([request.content.items.length]) }
    try {
      expect(await reader.read(input)).toBeUndefined()
      expect(factory).not.toHaveBeenCalled()
    } finally {
      await reader.dispose()
      vi.unstubAllGlobals()
    }
  }
)

it('awaits the same owned cleanup when cancellation occurs inside the document factory', async () => {
  const primary = withoutOutlineCache(document, request),
    controller = new AbortController(),
    started = Promise.withResolvers<void>(),
    finished = Promise.withResolvers<void>(),
    loading = Promise.withResolvers<Fixture['document']>(),
    destroy = vi.fn(async (): Promise<void> => {
      await finished.promise
      loading.reject(new Error('Owned loading task cancelled.'))
    }),
    factory = vi.fn((): ReturnType<typeof getDocument> => {
      controller.abort()
      started.resolve()
      return { promise: loading.promise, destroy } as unknown as ReturnType<typeof getDocument>
    })
  vi.stubGlobal('document', { createElement: vi.fn() })
  const reader = createAuxiliaryNativeInkReader({
    document: primary.document,
    nativeDocumentFactory: factory,
    sourceIdentity: identity,
    signal: controller.signal
  })
  try {
    const result = reader.read(primary.request)
    await Promise.race([
      started.promise,
      result.then((): never => {
        throw new Error('Factory was not reached.')
      })
    ])
    const first = reader.dispose(),
      second = reader.dispose()
    expect(first).toBe(second)
    expect(destroy).toHaveBeenCalledTimes(1)
    finished.resolve()
    expect(await result).toBeUndefined()
    await Promise.all([first, second])
    expect(destroy).toHaveBeenCalledTimes(1)
  } finally {
    finished.resolve()
    await reader.dispose()
    vi.unstubAllGlobals()
  }
})

it('rejects a genuine oversized page viewport before a DOM canvas can wrap its width', async () => {
  const fixture = await anonymousDocument(4294967396),
    primary = withoutOutlineCache(fixture.document, fixture.request),
    createElement = vi.fn(),
    factory = vi.fn(getDocument)
  expect(primary.request.viewport.width).toBe(4294967396)
  vi.stubGlobal('document', { createElement })
  const reader = createAuxiliaryNativeInkReader({
    document: primary.document,
    nativeDocumentFactory: factory,
    sourceIdentity: fixture.identity
  })
  try {
    expect(await reader.read(primary.request)).toBeUndefined()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(createElement).not.toHaveBeenCalled()
    expect(
      createHash('sha256')
        .update(await fixture.document.getData())
        .digest('hex')
    ).toBe(fixture.identity.sourceChecksum)
  } finally {
    await reader.dispose()
    await fixture.task.destroy()
    vi.unstubAllGlobals()
  }
})
