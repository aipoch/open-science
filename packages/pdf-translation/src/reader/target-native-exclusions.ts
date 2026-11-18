import type { PDFDocumentProxy, PDFPageProxy, getDocument } from 'pdfjs-dist'
import { createAuxiliaryNativeExclusionReader } from './auxiliary-native-ink.js'
import { isNativeFormBBoxExclusion, readNativeFormClippedText } from './native-form-clipped-text.js'
import { getPdfTranslationLayoutSnapshot } from './snapshot.js'
import type { PdfTranslationSource } from './source.js'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Item = Extract<Content['items'][number], { str: string }>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
type Exclusions = Readonly<{
  source: ReadonlySet<number>
  target: ReadonlySet<number>
  current: () => boolean
}>

/** Source coverage selects candidates; only the target's own native proof hides them. */
export function createPdfTranslationTargetExclusions(options: {
  source: PdfTranslationSource
  document: PDFDocumentProxy
  data: Uint8Array
  nativeDocumentFactory: typeof getDocument
  signal: AbortSignal
}): Readonly<{
  read: (input: {
    pageNumber: number
    sourceContent: Content
    targetPage: PDFPageProxy
    targetContent: Content
    targetViewport: Viewport
  }) => Promise<Exclusions | undefined>
  dispose: () => Promise<void>
}> {
  const { source, document, nativeDocumentFactory, signal } = options,
    coverage = getPdfTranslationLayoutSnapshot(source)?.coverage,
    apis = [document.getPage, document.getData, document.getMetadata],
    identity = JSON.stringify([document.fingerprints, document.numPages])
  let disposed = false,
    pending: Promise<ReturnType<typeof createAuxiliaryNativeExclusionReader>> | undefined
  const live = (): boolean =>
    !disposed &&
    !signal.aborted &&
    identity === JSON.stringify([document.fingerprints, document.numPages]) &&
    [document.getPage, document.getData, document.getMetadata].every((api, i) => api === apis[i])
  const digest = async (bytes: Uint8Array): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  const initialize = async (): Promise<ReturnType<typeof createAuxiliaryNativeExclusionReader>> => {
    if (!live() || !options.data.length || options.data.length > 64 * 1024 * 1024)
      throw new Error('Target native identity unavailable')
    const sourceIdentity = {
      sourceChecksum: await digest(options.data),
      sourceSizeBytes: options.data.length
    }
    const actual = await document.getData()
    if (
      !live() ||
      actual.length !== sourceIdentity.sourceSizeBytes ||
      (await digest(actual)) !== sourceIdentity.sourceChecksum
    )
      throw new Error('Target native identity changed')
    const reader = createAuxiliaryNativeExclusionReader(
      { document, sourceIdentity, nativeDocumentFactory, signal },
      readNativeFormClippedText
    )
    if (!live()) await reader.dispose()
    return reader
  }
  return {
    async read({ pageNumber, sourceContent, targetPage, targetContent, targetViewport }) {
      try {
        const excluded = coverage?.exclusions
          .filter((entry) => entry.reason === 'occluded-native-text')
          .flatMap((entry) => entry.items.filter((item) => item.pageNumber === pageNumber))
        if (!live() || !excluded?.length) return
        if (
          excluded.length * Math.max(sourceContent.items.length, targetContent.items.length) >
            1000000 ||
          sourceContent.items.length > 10000 ||
          targetContent.items.length > 10000 ||
          targetPage !== (await document.getPage(pageNumber))
        )
          return
        const before = JSON.stringify(sourceContent),
          claimed = new Set(
            source.units.flatMap((unit) =>
              unit.fragments.flatMap((fragment) =>
                fragment.pageNumber === pageNumber ? fragment.items.map((item) => item.index) : []
              )
            )
          ),
          from = new Set<number>(),
          selected = new Set<number>(),
          matches = (a: Item, b: Content['items'][number]): b is Item =>
            'str' in b &&
            a.str === b.str &&
            a.dir === b.dir &&
            [a.width, a.height, ...a.transform].every(Number.isFinite) &&
            [b.width, b.height, ...b.transform].every(Number.isFinite) &&
            a.transform.length === 6 &&
            b.transform.length === 6 &&
            Math.abs(a.width - b.width) < 0.001 &&
            Math.abs(a.height - b.height) < 0.001 &&
            a.transform.every((value, i) => Math.abs(value - b.transform[i]) < 0.001)
        for (const item of excluded) {
          const native = sourceContent.items[item.index]
          if (
            !native ||
            !('str' in native) ||
            !native.str.trim() ||
            native.str !== item.text ||
            claimed.has(item.index) ||
            from.has(item.index) ||
            sourceContent.items.filter((other) => matches(native, other)).length !== 1
          )
            return
          const targets = targetContent.items.flatMap((other, index) =>
            matches(native, other) ? [index] : []
          )
          if (targets.length !== 1 || selected.has(targets[0])) return
          from.add(item.index)
          selected.add(targets[0])
        }
        const reader = await (pending ??= initialize())
        if (!live()) return
        const direct = await readNativeFormClippedText(targetPage, targetContent, targetViewport)
        const proof = direct
          ? isNativeFormBBoxExclusion(direct, {
              page: targetPage,
              content: targetContent,
              viewport: targetViewport
            })
            ? direct
            : undefined
          : await reader.readNegativeExclusions({
              page: targetPage,
              content: targetContent,
              viewport: targetViewport,
              pageNumber,
              selected
            })
        if (
          !proof?.current() ||
          proof.indexes.size !== selected.size ||
          [...selected].some((index) => !proof.indexes.has(index))
        )
          return
        const sourceIndexes = [...from],
          targetIndexes = [...selected],
          current = (): boolean =>
            live() &&
            proof.current() &&
            from.size === sourceIndexes.length &&
            sourceIndexes.every((index) => from.has(index)) &&
            selected.size === targetIndexes.length &&
            targetIndexes.every((index) => selected.has(index)) &&
            JSON.stringify(sourceContent) === before
        return current() ? Object.freeze({ source: from, target: selected, current }) : undefined
      } catch {
        signal.throwIfAborted()
        return
      }
    },
    async dispose() {
      disposed = true
      // Initialization can fail before an auxiliary reader exists.
      const reader = await pending?.catch(() => undefined)
      await reader?.dispose()
    }
  }
}
