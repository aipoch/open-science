import type { PDFDocumentProxy, PDFPageProxy, getDocument } from 'pdfjs-dist'
import {
  nativeAlgorithmInkRegions,
  nativeTextFreeClipInkRegions
} from './native-source-geometry.js'
import { getPdfTranslationTextContent } from './text-content.js'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
type Ink = NonNullable<Awaited<ReturnType<typeof nativeAlgorithmInkRegions>>>
type Document = Pick<PDFDocumentProxy, 'getPage' | 'numPages' | 'fingerprints'> &
  Partial<Pick<PDFDocumentProxy, 'getData' | 'getMetadata'>>
type Request = Readonly<{
  page: PDFPageProxy
  content: Content
  viewport: Viewport
  pageNumber: number
  selected: ReadonlySet<number>
  operatorSnapshot?: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
}>
type SourceIdentity = Readonly<{ sourceChecksum: string; sourceSizeBytes: number }>
type Options = Readonly<{
  document: Document
  nativeDocumentFactory?: typeof getDocument
  sourceIdentity?: SourceIdentity
  signal?: AbortSignal
}>

export type AuxiliaryNativeInkReader = Readonly<{
  read: (input: Request) => Promise<Ink | undefined>
  dispose: () => Promise<void>
}>

const fontProperties = [
  'ascent',
  'bbox',
  'black',
  'bold',
  'charProcOperatorList',
  'cssFontInfo',
  'defaultVMetrics',
  'defaultWidth',
  'descent',
  'fallbackName',
  'fontExtraProperties',
  'fontMatrix',
  'isInvalidPDFjsFont',
  'isType3Font',
  'italic',
  'mimetype',
  'missingFile',
  'name',
  'remeasure',
  'systemFontInfo',
  'vertical',
  'cMap',
  'composite',
  'defaultEncoding',
  'differences',
  'isMonospace',
  'isSerifFont',
  'isSymbolicFont',
  'seacMap',
  'subtype',
  'toFontChar',
  'toUnicode',
  'type',
  'vmetrics',
  'widths'
] as const

function normalized(value: unknown, fonts: ReadonlyMap<string, string> = new Map()): unknown {
  if (value === undefined) return { undefined: true }
  if (typeof value === 'string') return fonts.get(value) ?? value
  if (ArrayBuffer.isView(value))
    return {
      type: value.constructor.name,
      values: Array.from(value as unknown as ArrayLike<number>)
    }
  if (Array.isArray(value)) return value.map((item): unknown => normalized(item, fonts))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key): [string, unknown] => [
          fonts.get(key) ?? key,
          normalized((value as Record<string, unknown>)[key], fonts)
        ])
        .sort(([a], [b]): number => a.localeCompare(b))
    )
  return value
}

function same(a: unknown, b: unknown, fonts?: ReadonlyMap<string, string>): boolean {
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b, fonts))
}

function requireEvidence(value: unknown): asserts value {
  if (!value) throw new Error('Incomplete auxiliary native evidence.')
}

async function digest(bytes: Uint8Array): Promise<string> {
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return Array.from(new Uint8Array(result), (n): string => n.toString(16).padStart(2, '0')).join('')
}

function viewportKey(viewport: Viewport): unknown {
  return {
    width: viewport.width,
    height: viewport.height,
    scale: viewport.scale,
    rotation: viewport.rotation,
    transform: [...viewport.transform]
  }
}

/** Identity only, not an ink certificate. The display caller compares this
 * before and after its asynchronous glyph/paint proofs. */
export async function nativeInkPageIdentity(
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport
): Promise<
  | Readonly<{
      key: string
      content: Content
      viewport: Viewport
      operators: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
    }>
  | undefined
> {
  try {
    const operators = await page.getOperatorList()
    if (
      operators.fnArray.length > 100000 ||
      operators.fnArray.length !== operators.argsArray.length
    )
      return
    let nodes = 0
    const dataOnly = (value: unknown): boolean => {
      if (++nodes > 1000000) return false
      if (!value || typeof value !== 'object') return typeof value !== 'function'
      if (ArrayBuffer.isView(value)) return !(value instanceof DataView)
      if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value)))
        return false
      return Reflect.ownKeys(value).every((key): boolean => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        return 'value' in descriptor && dataOnly(descriptor.value)
      })
    }
    if (!dataOnly(content) || !dataOnly(operators)) return
    for (const key of ['width', 'height', 'scale', 'rotation', 'transform']) {
      const descriptor = Object.getOwnPropertyDescriptor(viewport, key)
      if (!descriptor || !('value' in descriptor) || !dataOnly(descriptor.value)) return
    }
    const operatorSnapshot = structuredClone(operators),
      contentSnapshot = structuredClone(content),
      viewportSnapshot = structuredClone(viewportKey(viewport)) as Viewport,
      contentKey = normalized(contentSnapshot),
      operatorKey = normalized(operatorSnapshot),
      view = normalized(viewportKey(viewportSnapshot)),
      fonts: unknown[] = [],
      ids = [
        ...new Set(
          content.items.flatMap((i): string[] => ('str' in i && i.str.trim() ? [i.fontName] : []))
        )
      ]
    if (!ids.length || ids.length > 64) return
    let bytes = 0
    for (const id of ids) {
      const font = page.commonObjs.get(id)
      if (
        font?.loadedName !== id ||
        font.missingFile !== false ||
        !(font.data instanceof Uint8Array) ||
        !font.data.length ||
        (bytes += font.data.length) > 32 * 1024 * 1024
      )
        return
      fonts.push({
        id,
        program: await digest(font.data),
        properties: fontProperties.map((key): unknown => [key, normalized(font[key])])
      })
    }
    return {
      operators: operatorSnapshot,
      content: contentSnapshot,
      viewport: viewportSnapshot,
      key: JSON.stringify({
        content: contentKey,
        operators: operatorKey,
        viewport: view,
        fonts,
        page: normalized({
          ref: page.ref,
          view: page.view,
          rotate: page.rotate,
          userUnit: page.userUnit
        })
      })
    }
  } catch {
    return
  }
}

async function sameNativePage(
  primary: Request,
  page: PDFPageProxy,
  content: Content
): Promise<Awaited<ReturnType<PDFPageProxy['getOperatorList']>>> {
  requireEvidence(primary.content.items.length === content.items.length)
  const forward = new Map<string, string>(),
    reverse = new Map<string, string>()
  for (let index = 0; index < content.items.length; index++) {
    const a = primary.content.items[index],
      b = content.items[index]
    if (!('str' in a) || !('str' in b)) {
      requireEvidence(same(a, b))
      continue
    }
    const { fontName: aFont, ...aFields } = a,
      { fontName: bFont, ...bFields } = b
    requireEvidence(same(aFields, bFields))
    requireEvidence(
      aFont &&
        bFont &&
        (!forward.has(aFont) || forward.get(aFont) === bFont) &&
        (!reverse.has(bFont) || reverse.get(bFont) === aFont)
    )
    forward.set(aFont, bFont)
    reverse.set(bFont, aFont)
  }
  requireEvidence(same(primary.content, content, reverse))
  const [aOriginal, bOriginal] = await Promise.all([
    primary.page.getOperatorList(),
    page.getOperatorList()
  ])
  const aOperators = structuredClone(aOriginal),
    bOperators = structuredClone(bOriginal)
  if (primary.operatorSnapshot) requireEvidence(same(aOperators, primary.operatorSnapshot))
  requireEvidence(aOperators.fnArray.length <= 100000 && same(aOperators, bOperators, reverse))
  requireEvidence(same(viewportKey(primary.viewport), viewportKey(page.getViewport({ scale: 1 }))))
  requireEvidence(
    same(
      {
        ref: primary.page.ref,
        view: primary.page.view,
        rotate: primary.page.rotate,
        userUnit: primary.page.userUnit
      },
      { ref: page.ref, view: page.view, rotate: page.rotate, userUnit: page.userUnit }
    )
  )
  requireEvidence(forward.size > 0 && forward.size <= 64)
  let programBytes = 0
  for (const [aId, bId] of forward) {
    const a = primary.page.commonObjs.get(aId),
      b = page.commonObjs.get(bId)
    requireEvidence(
      a?.loadedName === aId &&
        b?.loadedName === bId &&
        a.missingFile === false &&
        b.missingFile === false &&
        a.data instanceof Uint8Array &&
        b.data instanceof Uint8Array &&
        a.data.byteLength > 0 &&
        a.data.byteLength === b.data.byteLength
    )
    programBytes += a.data.byteLength
    requireEvidence(programBytes <= 32 * 1024 * 1024)
    requireEvidence((await digest(a.data)) === (await digest(b.data)))
    requireEvidence(fontProperties.every((key): boolean => same(a[key], b[key], reverse)))
  }
  return bOperators
}

async function missingNativeOutline(page: PDFPageProxy): Promise<boolean> {
  if (!page.commonObjs) return false
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
    ops = await page.getOperatorList()
  if (ops.fnArray.length !== ops.argsArray.length || ops.fnArray.length > 100000) return false
  let font = ''
  for (let index = 0; index < ops.fnArray.length; index++) {
    if (ops.fnArray[index] === OPS.setFont) font = ops.argsArray[index]?.[0]
    if (ops.fnArray[index] !== OPS.showText || !font || !page.commonObjs.has(font)) continue
    const object = page.commonObjs.get(font)
    if (object?.missingFile !== false || typeof object.loadedName !== 'string') continue
    for (const glyph of ops.argsArray[index]?.[0] ?? [])
      if (
        typeof glyph?.fontChar === 'string' &&
        glyph.fontChar &&
        !page.commonObjs.has(object.loadedName + '_path_' + glyph.fontChar)
      )
        return true
  }
  return false
}

/** An owned, lazy evidence document; it never replaces or populates primary objects. */
export function createAuxiliaryNativeInkReader(options: Options): AuxiliaryNativeInkReader {
  return createNativeInkReader(options, nativeAlgorithmInkRegions)
}

/** The same document identity/lifecycle proof, with an independently checked
 * text-free clip lifetime. Graphical paint still needs a separate certificate. */
export function createAuxiliaryNativeDisplayInkReader(options: Options): AuxiliaryNativeInkReader {
  return createNativeInkReader(options, nativeTextFreeClipInkRegions)
}

function createNativeInkReader(
  { document: primary, nativeDocumentFactory, sourceIdentity, signal }: Options,
  readInk: typeof nativeTextFreeClipInkRegions
): AuxiliaryNativeInkReader {
  let task: ReturnType<typeof getDocument> | undefined,
    pending: Promise<PDFDocumentProxy> | undefined,
    render: ReturnType<PDFPageProxy['render']> | undefined,
    disposed = false,
    closing: ReturnType<typeof getDocument> | undefined,
    cleanup: Promise<void> | undefined
  const records = new Map<
    number,
    {
      request: Request
      content: string
      viewport: unknown
      selected: Set<number>
      operatorSnapshot: string | undefined
      result: Promise<Ink | undefined>
    }
  >()
  const live = (): void => {
    signal?.throwIfAborted()
    requireEvidence(!disposed)
  }
  const closeOwnedTask = (): Promise<void> => {
    if (!task || closing === task) return cleanup ?? Promise.resolve()
    const owned = task
    closing = owned
    // During Worker startup, destroy marks it cancelled before the ready/test
    // handshake physically terminates it. The public loading promise settles
    // after that handshake, and also handles the expected cancellation rejection.
    const settled = owned.promise.catch((): undefined => undefined)
    cleanup = (async (): Promise<void> => {
      try {
        await owned.destroy()
      } catch {
        /* The main document remains borrowed. */
      }
      await settled
    })()
    return cleanup
  }
  const dispose = (): Promise<void> => {
    if (!disposed) {
      disposed = true
      signal?.removeEventListener('abort', onAbort)
      render?.cancel()
      records.clear()
    }
    return closeOwnedTask()
  }
  const onAbort = (): void => {
    void dispose()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const initialize = async (): Promise<PDFDocumentProxy> => {
    live()
    requireEvidence(
      nativeDocumentFactory && primary.getData && primary.getMetadata && sourceIdentity
    )
    const bytes = await primary.getData()
    live()
    requireEvidence(
      bytes instanceof Uint8Array &&
        bytes.length > 0 &&
        bytes.length <= 64 * 1024 * 1024 &&
        bytes.length === sourceIdentity.sourceSizeBytes &&
        (await digest(bytes)) === sourceIdentity.sourceChecksum
    )
    live()
    task = nativeDocumentFactory({
      data: bytes.slice(),
      fontExtraProperties: true,
      disableFontFace: true,
      isEvalSupported: false
    })
    if (disposed || signal?.aborted) {
      await closeOwnedTask()
      live()
    }
    const auxiliary = await task.promise
    live()
    requireEvidence(
      same(primary.fingerprints, auxiliary.fingerprints) &&
        primary.numPages === auxiliary.numPages &&
        (await digest(await auxiliary.getData())) === sourceIdentity.sourceChecksum
    )
    const [a, b] = await Promise.all([primary.getMetadata(), auxiliary.getMetadata()])
    requireEvidence(same(a.info, b.info) && a.metadata?.getRaw() === b.metadata?.getRaw())
    return auxiliary
  }
  const prove = async (input: Request): Promise<Ink> => {
    live()
    requireEvidence(input.page === (await primary.getPage(input.pageNumber)))
    requireEvidence(same(input.content, await getPdfTranslationTextContent(input.page)))
    requireEvidence(
      same(viewportKey(input.viewport), viewportKey(input.page.getViewport({ scale: 1 })))
    )
    requireEvidence(
      !(await readInk(
        input.page,
        input.content,
        input.viewport,
        input.pageNumber,
        input.selected,
        input.operatorSnapshot
      ))
    )
    requireEvidence(await missingNativeOutline(input.page))
    const auxiliary = await (pending ??= initialize()),
      page = await auxiliary.getPage(input.pageNumber),
      content = await getPdfTranslationTextContent(page)
    live()
    const operatorSnapshot = await sameNativePage(input, page, content)
    const viewport = page.getViewport({ scale: 1 }),
      width = Math.ceil(viewport.width),
      height = Math.ceil(viewport.height)
    requireEvidence(
      Number.isSafeInteger(width) &&
        Number.isSafeInteger(height) &&
        width > 0 &&
        height > 0 &&
        width * height <= 4000000
    )
    const canvas = globalThis.document.createElement('canvas')
    try {
      canvas.width = width
      canvas.height = height
      requireEvidence(canvas.width === width && canvas.height === height)
      const context = canvas.getContext('2d')
      requireEvidence(context)
      render = page.render({ canvas, canvasContext: context, viewport })
      await render.promise
      render = undefined
      live()
    } finally {
      canvas.width = canvas.height = 0
    }
    const ink = await readInk(
        page,
        content,
        viewport,
        input.pageNumber,
        input.selected,
        operatorSnapshot
      ),
      nonempty = input.content.items.flatMap((item, index): number[] =>
        'str' in item && item.str.trim() ? [index] : []
      )
    requireEvidence(
      ink && ink.size === nonempty.length && nonempty.every((index): boolean => ink.has(index))
    )
    live()
    return ink
  }
  const copy = (ink: Ink | undefined): Ink | undefined =>
    ink &&
    new Map(
      [...ink].map(([index, rect]): [number, typeof rect] => [index, Object.freeze({ ...rect })])
    )
  return {
    async read(input): Promise<Ink | undefined> {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        live()
        requireEvidence(
          nativeDocumentFactory &&
            primary.getData &&
            primary.getMetadata &&
            sourceIdentity &&
            /^[a-f0-9]{64}$/u.test(sourceIdentity.sourceChecksum) &&
            Number.isSafeInteger(sourceIdentity.sourceSizeBytes) &&
            typeof globalThis.document?.createElement === 'function' &&
            typeof globalThis.crypto?.subtle?.digest === 'function'
        )
        requireEvidence(
          Number.isSafeInteger(input.pageNumber) &&
            input.pageNumber > 0 &&
            input.pageNumber <= primary.numPages &&
            input.viewport.scale === 1 &&
            input.viewport.rotation === 0 &&
            input.content.items.length <= 10000 &&
            input.selected.size > 0 &&
            input.selected.size <= 10000 &&
            [...input.selected].every(
              (index): boolean =>
                Number.isSafeInteger(index) &&
                index >= 0 &&
                'str' in input.content.items[index] &&
                !!input.content.items[index].str.trim()
            )
        )
        const previous = records.get(input.pageNumber)
        if (previous) {
          requireEvidence(
            previous.request.page === input.page &&
              previous.request.content === input.content &&
              previous.content === JSON.stringify(normalized(input.content)) &&
              same(previous.viewport, viewportKey(input.viewport)) &&
              previous.operatorSnapshot ===
                (input.operatorSnapshot && JSON.stringify(normalized(input.operatorSnapshot))) &&
              previous.selected.size === input.selected.size &&
              [...input.selected].every((index): boolean => previous.selected.has(index))
          )
          const ink = await previous.result
          live()
          requireEvidence(
            previous.content === JSON.stringify(normalized(input.content)) &&
              same(previous.viewport, viewportKey(input.viewport)) &&
              previous.operatorSnapshot ===
                (input.operatorSnapshot && JSON.stringify(normalized(input.operatorSnapshot))) &&
              previous.selected.size === input.selected.size &&
              [...input.selected].every((index): boolean => previous.selected.has(index))
          )
          return copy(ink)
        }
        requireEvidence(records.size < 16)
        const result = Promise.race([
          prove(input),
          new Promise<never>((_, reject): void => {
            timer = setTimeout((): void => {
              void dispose()
              reject(new Error('Auxiliary evidence timed out.'))
            }, 20000)
          })
        ]).catch((): undefined => undefined)
        const content = JSON.stringify(normalized(input.content)),
          viewport = viewportKey(input.viewport),
          operatorSnapshot =
            input.operatorSnapshot && JSON.stringify(normalized(input.operatorSnapshot)),
          selected = new Set(input.selected)
        records.set(input.pageNumber, {
          request: input,
          content,
          viewport,
          selected,
          operatorSnapshot,
          result
        })
        const ink = await result
        live()
        requireEvidence(
          content === JSON.stringify(normalized(input.content)) &&
            same(viewport, viewportKey(input.viewport)) &&
            operatorSnapshot ===
              (input.operatorSnapshot && JSON.stringify(normalized(input.operatorSnapshot))) &&
            selected.size === input.selected.size &&
            [...input.selected].every((index): boolean => selected.has(index))
        )
        return copy(ink)
      } catch {
        return undefined
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    dispose
  }
}
