import type { PDFDocumentProxy, PDFPageProxy, getDocument } from 'pdfjs-dist'
import {
  nativeAlgorithmInkRegions,
  nativeAlgorithmCaptionInk,
  nativeIsolatedPlotCaptionInk,
  nativeTerminalPlotCaptionInk,
  carryNativeTerminalPlotScope,
  nativeTextFreeClipInkRegions
} from './native-source-geometry.js'
import { readNativeFormClippedText, isNativeFormBBoxExclusion } from './native-form-clipped-text.js'
import { getPdfTranslationTextContent } from './text-content.js'
import {
  digest,
  fontProperties,
  nativeInkPageCurrent,
  nativeInkPageIdentity,
  nativeInkPageWitness,
  normalized,
  requireEvidence,
  same,
  viewportKey
} from './native-ink-page-state.js'

export { nativeInkPageCurrent, nativeInkPageIdentity }

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

// Only hard Form clipping is independent of image payload. Match allocator
// names at their image use/dependency slots; this never creates ink evidence.
async function hardFormImageComparison(
  primary: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  auxiliary: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>,
  fonts: ReadonlyMap<string, string>
): Promise<typeof auxiliary | undefined> {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (
    !same(primary.fnArray, auxiliary.fnArray) ||
    primary.argsArray.length !== auxiliary.argsArray.length ||
    primary.argsArray.length !== primary.fnArray.length
  )
    return
  const unsupported = new Set([
    OPS.paintImageXObjectRepeat,
    OPS.paintInlineImageXObject,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageMaskXObject,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintImageMaskXObjectRepeat,
    OPS.paintSolidColorImageMask,
    OPS.setFillColorN,
    OPS.setStrokeColorN,
    OPS.shadingFill
  ])
  const forward = new Map<string, string>(),
    reverse = new Map<string, string>(),
    fontIds = new Set([...fonts.keys(), ...fonts.values()])
  const imageId = (id: unknown): id is string =>
    typeof id === 'string' && id.length <= 80 && /^img_p\d+_\d+$/u.test(id) && !fontIds.has(id)
  for (const [index, op] of primary.fnArray.entries()) {
    if (unsupported.has(op)) return
    if (op !== OPS.paintImageXObject) continue
    const a = primary.argsArray[index],
      b = auxiliary.argsArray[index]
    if (
      !Array.isArray(a) ||
      !Array.isArray(b) ||
      a.length !== 3 ||
      b.length !== 3 ||
      !imageId(a[0]) ||
      !imageId(b[0]) ||
      ![a[1], a[2], b[1], b[2]].every((n) => Number.isSafeInteger(n) && n > 0) ||
      (forward.has(a[0]) && forward.get(a[0]) !== b[0]) ||
      (reverse.has(b[0]) && reverse.get(b[0]) !== a[0])
    )
      return
    forward.set(a[0], b[0])
    reverse.set(b[0], a[0])
  }
  if (!reverse.size) return
  const aDependencies = new Set<string>(),
    bDependencies = new Set<string>(),
    argsArray = auxiliary.argsArray.slice()
  for (const [index, op] of primary.fnArray.entries()) {
    const a = primary.argsArray[index],
      b = auxiliary.argsArray[index]
    if (op === OPS.dependency) {
      if (
        !Array.isArray(a) ||
        !Array.isArray(b) ||
        a.length !== b.length ||
        a.some((id) => typeof id !== 'string') ||
        b.some((id) => typeof id !== 'string')
      )
        return
      const next = b.slice()
      for (let slot = 0; slot < b.length; slot++) {
        if (reverse.has(b[slot])) {
          if (reverse.get(b[slot]) !== a[slot]) return
          next[slot] = a[slot]
        } else if (forward.has(a[slot])) return
        aDependencies.add(a[slot])
        bDependencies.add(b[slot])
      }
      argsArray[index] = next
    } else if (op === OPS.paintImageXObject) {
      if (!aDependencies.has(a[0]) || !bDependencies.has(b[0])) return
      argsArray[index] = [reverse.get(b[0]), ...b.slice(1)]
    }
  }
  return { ...auxiliary, argsArray }
}

async function sameNativePage(
  primary: Request,
  page: PDFPageProxy,
  content: Content,
  hardFormBBox = false
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
  requireEvidence(aOperators.fnArray.length <= 100000)
  const imageComparison =
    hardFormBBox && !same(aOperators, bOperators, reverse)
      ? await hardFormImageComparison(aOperators, bOperators, reverse)
      : undefined
  requireEvidence(same(aOperators, imageComparison ?? bOperators, reverse))
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
  options: Options,
  readInk: typeof nativeTextFreeClipInkRegions,
  carryInk?: (from: Ink, to: Ink) => void
): AuxiliaryNativeInkReader {
  return createNativeEvidenceReader(options, readInk, carryInk, false)
}

/** Selected native observations for exclusion or whole-page fallback only.
 * Deliberately incompatible with the complete-page positive ink reader. */
export function createAuxiliaryNativeNegativeReader(
  options: Options,
  readSelected: typeof nativeTextFreeClipInkRegions,
  carrySelected?: (from: Ink, to: Ink) => void
): Readonly<{
  readNegativeSelection: (input: Request) => Promise<
    | Readonly<{
        negativeOnly: true
        items: ReadonlyMap<
          number,
          { page: number; x: number; y: number; width: number; height: number }
        >
      }>
    | undefined
  >
  dispose: () => Promise<void>
}> {
  const reader = createNativeEvidenceReader(options, readSelected, carrySelected, true)
  return {
    async readNegativeSelection(input) {
      const items = await reader.read(input)
      return items && Object.freeze({ negativeOnly: true as const, items })
    },
    dispose: reader.dispose
  }
}

type NativeExclusion = Readonly<{ indexes: ReadonlySet<number>; current: () => boolean }>
type Observation<T> = Readonly<{
  read: (
    page: PDFPageProxy,
    content: Content,
    viewport: Viewport,
    pageNumber: number,
    selected: ReadonlySet<number>,
    operators?: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
  ) => Promise<T | undefined>
  valid: (value: T, input: Request) => boolean
  copy: (value: T, current: () => boolean) => T
  bindPrimary?: boolean
  hardFormBBox?: boolean
}>

/** Exclusions are never ink or permission to move or translate an item. */
export function createAuxiliaryNativeExclusionReader(
  options: Options,
  readExcluded: (
    page: PDFPageProxy,
    content: Content,
    viewport: Viewport
  ) => Promise<NativeExclusion | undefined>
): Readonly<{
  readNegativeExclusions: (
    input: Request
  ) => Promise<(NativeExclusion & { negativeOnly: true }) | undefined>
  dispose: () => Promise<void>
}> {
  const hardFormBBox = readExcluded === readNativeFormClippedText
  const reader = createNativeObservationReader<NativeExclusion>(options, {
    read: hardFormBBox
      ? async (page, content, viewport) => {
          const proof = await readExcluded(page, content, viewport)
          return isNativeFormBBoxExclusion(proof, { page, content, viewport }) ? proof : undefined
        }
      : readExcluded,
    valid: (proof, input) =>
      (!hardFormBBox || isNativeFormBBoxExclusion(proof)) &&
      proof.current() &&
      proof.indexes.size > 0 &&
      [...proof.indexes].every((index) => input.selected.has(index)),
    copy: (proof, current) => {
      const indexes = new Set(proof.indexes),
        expected = [...indexes]
      return Object.freeze({
        indexes,
        current: () =>
          proof.current() &&
          current() &&
          indexes.size === expected.length &&
          proof.indexes.size === expected.length &&
          expected.every((index) => indexes.has(index) && proof.indexes.has(index))
      })
    },
    bindPrimary: true,
    hardFormBBox
  })
  return {
    async readNegativeExclusions(input) {
      const proof = await reader.read(input)
      return proof && Object.freeze({ ...proof, negativeOnly: true as const })
    },
    dispose: reader.dispose
  }
}

function createNativeEvidenceReader(
  options: Options,
  readInk: typeof nativeTextFreeClipInkRegions,
  carryInk: ((from: Ink, to: Ink) => void) | undefined,
  negativeSelected: boolean
): AuxiliaryNativeInkReader {
  return createNativeObservationReader(options, {
    read: readInk,
    valid: (ink, input) => {
      const expected = negativeSelected
        ? [...input.selected]
        : input.content.items.flatMap((item, index): number[] =>
            'str' in item && item.str.trim() ? [index] : []
          )
      return ink.size === expected.length && expected.every((index) => ink.has(index))
    },
    copy: (ink) => {
      const next = new Map(
        [...ink].map(([index, rect]): [number, typeof rect] => [index, Object.freeze({ ...rect })])
      )
      carryInk?.(ink, next)
      return next
    }
  })
}

function createNativeObservationReader<T>(
  { document: primary, nativeDocumentFactory, sourceIdentity, signal }: Options,
  observation: Observation<T>
): Readonly<{ read: (input: Request) => Promise<T | undefined>; dispose: () => Promise<void> }> {
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
      result: Promise<T | undefined>
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
  const prove = async (input: Request): Promise<T> => {
    live()
    requireEvidence(input.page === (await primary.getPage(input.pageNumber)))
    requireEvidence(same(input.content, await getPdfTranslationTextContent(input.page)))
    requireEvidence(
      same(viewportKey(input.viewport), viewportKey(input.page.getViewport({ scale: 1 })))
    )
    requireEvidence(
      !(await observation.read(
        input.page,
        input.content,
        input.viewport,
        input.pageNumber,
        input.selected,
        input.operatorSnapshot
      ))
    )
    if (observation.bindPrimary) {
      const operators = await input.page.getOperatorList()
      const primaryProof = nativeInkPageWitness(
        input.page,
        input.content,
        input.viewport,
        operators,
        []
      )
      requireEvidence(primaryProof && primaryProof.current())
      proofChecks.push(primaryProof)
    }
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
    const operatorSnapshot = await sameNativePage(
      input,
      page,
      content,
      observation.hardFormBBox === true
    )
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
    const ink = await observation.read(
      page,
      content,
      viewport,
      input.pageNumber,
      input.selected,
      operatorSnapshot
    )
    requireEvidence(ink && observation.valid(ink, input))
    live()
    requireEvidence(proof.current())
    proofChecks.push(proof)
    return ink
  }
  const sourceBinding = JSON.stringify([primary.fingerprints, primary.numPages, sourceIdentity])
  const documentApis = [primary.getPage, primary.getData, primary.getMetadata]
  const current = (): boolean => {
    try {
      live()
      requireEvidence(proofChecks.every((proof) => proof.current()))
      requireEvidence(
        JSON.stringify([primary.fingerprints, primary.numPages, sourceIdentity]) === sourceBinding
      )
      requireEvidence(
        [primary.getPage, primary.getData, primary.getMetadata].every(
          (api, index) => api === documentApis[index]
        )
      )
      for (const record of records.values()) {
        const input = record.request
        requireEvidence(
          record.content === JSON.stringify(normalized(input.content)) &&
            same(record.viewport, viewportKey(input.viewport)) &&
            record.operatorSnapshot ===
              (input.operatorSnapshot && JSON.stringify(normalized(input.operatorSnapshot))) &&
            record.selected.size === input.selected.size &&
            [...input.selected].every((index) => record.selected.has(index))
        )
      }
      return true
    } catch {
      return false
    }
  }
  const copy = (value: T | undefined): T | undefined => value && observation.copy(value, current)
  return {
    async read(input): Promise<T | undefined> {
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
          if (observation.bindPrimary) requireEvidence(current())
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
        if (observation.bindPrimary) requireEvidence(current())
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
