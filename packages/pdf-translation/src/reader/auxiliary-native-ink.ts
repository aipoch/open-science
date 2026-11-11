import type { PDFDocumentProxy, PDFPageProxy, getDocument } from 'pdfjs-dist'
import {
  nativeAlgorithmInkRegions,
  nativeAlgorithmCaptionInk,
  nativeIsolatedPlotCaptionInk,
  nativeTerminalPlotCaptionInk,
  carryNativeTerminalPlotScope,
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

/** No promise is allowed between this bounded byte/reference check and Source commit. */
export function nativeInkPageCurrent(
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  operators: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  outlineKeys: readonly string[]
): (() => boolean) | undefined {
  return nativeInkPageWitness(page, content, viewport, operators, outlineKeys)?.current
}

function nativeInkPageWitness(
  page: PDFPageProxy,
  content: Content,
  viewport: Viewport,
  operators: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  outlineKeys: readonly string[]
): { current: () => boolean; released: () => boolean } | undefined {
  try {
    const common = page.commonObjs,
      get = common.get,
      has = common.has,
      apis = [page.getTextContent, page.getOperatorList, page.getViewport],
      reference = page.ref,
      view = page.view,
      fonts: {
        id: string
        font: Record<string, unknown>
        data: Uint8Array
        bytes: Uint8Array
        slots: (() => boolean)[]
      }[] = [],
      references: [object, string, object][] = [],
      seen = new Set<object>()
    const bind = (value: unknown): void => {
      if (!value || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      if (seen.size > 100000) throw Error('Native reference budget.')
      if (ArrayBuffer.isView(value)) return
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor)) throw Error('Native accessor.')
        if (descriptor.value && typeof descriptor.value === 'object') {
          references.push([value, key, descriptor.value])
          bind(descriptor.value)
        }
      }
    }
    // PDF.js exposes font data as fresh views and metrics as freshly decoded
    // arrays. Bind the property lookup itself; compare its decoded value below.
    // A data property, including a shadow over a getter, retains exact identity.
    const slot = (font: object, key: string): (() => boolean) => {
      const chain: {
        owner: object
        parent: object | null
        descriptor: PropertyDescriptor | undefined
      }[] = []
      let owner: object | null = font
      while (owner) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key),
          parent = Object.getPrototypeOf(owner)
        chain.push({ owner, parent, descriptor })
        if (descriptor) {
          if ('value' in descriptor) bind(descriptor.value)
          break
        }
        owner = parent
      }
      return () =>
        chain.every(({ owner, parent, descriptor }) => {
          const now = Object.getOwnPropertyDescriptor(owner, key)
          return (
            Object.getPrototypeOf(owner) === parent &&
            (descriptor === undefined
              ? now === undefined
              : now !== undefined &&
                ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(
                  (field) =>
                    now[field as keyof PropertyDescriptor] ===
                    descriptor[field as keyof PropertyDescriptor]
                ))
          )
        })
    }
    let bytes = 0
    for (const id of new Set(
      content.items.flatMap((item) => ('str' in item && item.str.trim() ? [item.fontName] : []))
    )) {
      const font = common.get(id),
        data = font?.data
      if (
        !font ||
        font.loadedName !== id ||
        font.missingFile !== false ||
        !(data instanceof Uint8Array) ||
        !(data.buffer instanceof ArrayBuffer) ||
        !data.length ||
        (bytes += data.length) > 32 * 1024 * 1024 ||
        fonts.length >= 64
      )
        return
      const slots = ['loadedName', 'data', ...fontProperties].map((key) => slot(font, key))
      fonts.push({ id, font, data, bytes: data.slice(), slots })
    }
    if (!fonts.length) return
    let outlineBytes = 0
    const outlines: ((released: boolean) => boolean)[] = []
    for (const key of new Set(outlineKeys)) {
      if (outlines.length >= 10000) return
      const present = common.has(key)
      if (!present) {
        outlines.push((released) => released || !common.has(key))
        continue
      }
      const owner = common.get(key),
        path = owner?.path,
        currentSlot = slot(owner, 'path')
      if (
        !ArrayBuffer.isView(path) ||
        path instanceof DataView ||
        !(path.buffer instanceof ArrayBuffer) ||
        (outlineBytes += path.byteLength) > 16 * 1024 * 1024
      )
        return
      const pathKey = JSON.stringify(normalized(path))
      outlines.push((released) => {
        const now = owner.path
        return (
          (released || (common.has(key) && common.get(key) === owner)) &&
          currentSlot() &&
          ArrayBuffer.isView(now) &&
          now.buffer === path.buffer &&
          now.byteOffset === path.byteOffset &&
          now.byteLength === path.byteLength &&
          JSON.stringify(normalized(now)) === pathKey
        )
      })
    }
    bind([content, operators, viewport.transform, reference, view])
    const values = (): unknown =>
        normalized([
          content,
          operators,
          viewportKey(viewport),
          page.ref,
          page.view,
          page.rotate,
          page.userUnit,
          fonts.map(({ font }) => fontProperties.map((key) => font[key]))
        ]),
      snapshot = JSON.stringify(values())
    const check = (released: boolean): boolean => {
      try {
        if (
          page.commonObjs !== common ||
          common.get !== get ||
          common.has !== has ||
          page.ref !== reference ||
          page.view !== view ||
          ![page.getTextContent, page.getOperatorList, page.getViewport].every(
            (api, i) => api === apis[i]
          ) ||
          references.some(
            ([parent, key, value]) => Object.getOwnPropertyDescriptor(parent, key)?.value !== value
          ) ||
          JSON.stringify(values()) !== snapshot
        )
          return false
        for (const entry of fonts) {
          const data = entry.font.data
          if (
            (!released && common.get(entry.id) !== entry.font) ||
            entry.font.loadedName !== entry.id ||
            !entry.slots.every((current) => current()) ||
            !(data instanceof Uint8Array) ||
            data.buffer !== entry.data.buffer ||
            data.byteOffset !== entry.data.byteOffset ||
            data.length !== entry.bytes.length
          )
            return false
          for (let i = 0; i < entry.bytes.length; i++) if (data[i] !== entry.bytes[i]) return false
        }
        return outlines.every((current) => current(released))
      } catch {
        return false
      }
    }
    return { current: () => check(false), released: () => check(true) }
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

/** Terminal float Forms use a separate, complete exterior-caption proof. */
export function createAuxiliaryNativeTerminalCaptionInkReader(
  options: Options
): AuxiliaryNativeInkReader {
  return createNativeInkReader(options, nativeTerminalPlotCaptionInk, carryNativeTerminalPlotScope)
}

/** Caption isolation has its own full native program proof and keeps this lifecycle unchanged. */
export function createAuxiliaryNativeCaptionInkReader(options: Options): AuxiliaryNativeInkReader {
  return createNativeInkReader(options, nativeIsolatedPlotCaptionInk)
}

export function createNativeInkReader(
  { document: primary, nativeDocumentFactory, sourceIdentity, signal }: Options,
  readInk: typeof nativeTextFreeClipInkRegions,
  carryInk?: (from: Ink, to: Ink) => void
): AuxiliaryNativeInkReader {
  let task: ReturnType<typeof getDocument> | undefined,
    pending: Promise<PDFDocumentProxy> | undefined,
    render: ReturnType<PDFPageProxy['render']> | undefined,
    disposed = false,
    closing: ReturnType<typeof getDocument> | undefined,
    cleanup: Promise<void> | undefined,
    cleanupCheckSource: Promise<void> | undefined,
    checkedCleanup: Promise<void> | undefined
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
  const proofChecks: NonNullable<ReturnType<typeof nativeInkPageWitness>>[] = []
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
    const closing = closeOwnedTask()
    if (closing !== cleanupCheckSource) {
      cleanupCheckSource = closing
      checkedCleanup = closing.then(() => {
        // Destroy may release the object registry, but the exact font bytes,
        // glyph outline owners and their slots used by a published proof stay bound.
        requireEvidence(proofChecks.every((proof) => proof.released()))
      })
    }
    return checkedCleanup!
  }
  const onAbort = (): void => {
    void dispose().catch(() => undefined)
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
    const viewport = page.getViewport({ scale: 1 }),
      width = Math.ceil(viewport.width),
      height = Math.ceil(viewport.height)
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
      operators = await page.getOperatorList(),
      outlineKeys = new Set<string>(),
      stack: string[] = []
    let font = ''
    for (const [index, op] of operators.fnArray.entries()) {
      const args = operators.argsArray[index]
      if (op === OPS.setFont) font = args[0]
      else if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) stack.push(font)
      else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op))
        font = stack.pop() ?? ''
      else if (op === OPS.showText)
        for (const glyph of args[0])
          if (typeof glyph?.fontChar === 'string') outlineKeys.add(font + '_path_' + glyph.fontChar)
    }
    // disableFontFace materializes these paths with the operator list. Do not
    // certify outlines first observed after an unbound asynchronous render.
    requireEvidence([...outlineKeys].every((key) => page.commonObjs.has(key)))
    const proof = nativeInkPageWitness(page, content, viewport, operators, [...outlineKeys])
    requireEvidence(proof)
    const operatorSnapshot = await sameNativePage(input, page, content)
    requireEvidence(proof.current())
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
      requireEvidence(proof.current())
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
    requireEvidence(proof.current())
    proofChecks.push(proof)
    return ink
  }
  const copy = (ink: Ink | undefined): Ink | undefined => {
    if (!ink) return
    const next = new Map(
      [...ink].map(([index, rect]): [number, typeof rect] => [index, Object.freeze({ ...rect })])
    )
    carryInk?.(ink, next)
    return next
  }
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
          requireEvidence(proofChecks.every((proof) => proof.current()))
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
              void dispose().catch(() => undefined)
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
        requireEvidence(proofChecks.every((proof) => proof.current()))
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

/** The same bounded identity lifecycle for a complete ruled algorithm caption. */
export function createAuxiliaryNativeAlgorithmCaptionInkReader(
  options: Options
): AuxiliaryNativeInkReader {
  return createNativeInkReader(options, nativeAlgorithmCaptionInk)
}
