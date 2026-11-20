import { readFile, stat } from 'node:fs/promises'
import type { PdfProseRegion } from '../../shared/pdf-text'
import {
  MAX_AUTO_EXTRACT_PDF_BYTES,
  MAX_CONCURRENT_PDF_TEXT_EXTRACTIONS,
  MAX_PDF_TEXT_CHARS,
  resolvePdfjsAssetUrls,
  type AttachmentByteSource,
  type PdfTextResult,
  type TargetedPdfTextResult
} from './attachment-media'
import type { createPdfOcrSession } from './pdf-ocr'

let activePdfTextExtractions = 0
const pendingPdfTextExtractions: Array<() => void> = []

const withPdfTextExtractionSlot = async <Result>(
  work: () => Promise<Result>,
  signal?: AbortSignal
): Promise<Result> => {
  signal?.throwIfAborted()
  if (activePdfTextExtractions >= MAX_CONCURRENT_PDF_TEXT_EXTRACTIONS) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => signal?.removeEventListener('abort', aborted)
      const grant = (): void => {
        cleanup()
        activePdfTextExtractions += 1
        resolve()
      }
      const aborted = (): void => {
        const index = pendingPdfTextExtractions.indexOf(grant)
        if (index >= 0) pendingPdfTextExtractions.splice(index, 1)
        cleanup()
        reject(signal?.reason)
      }
      pendingPdfTextExtractions.push(grant)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
  } else activePdfTextExtractions += 1
  try {
    signal?.throwIfAborted()
    return await work()
  } finally {
    activePdfTextExtractions -= 1
    pendingPdfTextExtractions.shift()?.()
  }
}

const abortable = <T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', aborted)
    const aborted = (): void => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
    pending.then(
      (value) => {
        cleanup()
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
    if (signal.aborted) aborted()
  })
}

// Extracts selectable text from a PDF so the model receives readable content instead of the raw
// (base64) file, which would otherwise overflow the request size limit.
export const extractPdfText = async (
  filePath: string,
  targetPageOrSource?: number | AttachmentByteSource,
  options: Readonly<{
    maxChars?: number
    proseRegions?: readonly PdfProseRegion[]
    ocr?: boolean
    createOcrSession?: () => ReturnType<typeof createPdfOcrSession>
    includeLayout?: boolean
    signal?: AbortSignal
  }> = {}
): Promise<PdfTextResult> => {
  const signal = options.signal
  signal?.throwIfAborted()
  const source = typeof targetPageOrSource === 'object' ? targetPageOrSource : undefined
  const targetPageNumber = typeof targetPageOrSource === 'number' ? targetPageOrSource : undefined
  const size = source?.size ?? (await stat(filePath)).size
  if (size > MAX_AUTO_EXTRACT_PDF_BYTES) {
    throw new Error(`PDF source is ${size} bytes, exceeding the automatic extraction limit.`)
  }
  return withPdfTextExtractionSlot(async () => {
    const { readPdfPageText } = await import('./pdf-reading-order')
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
    signal?.throwIfAborted()
    const { cMapUrl, standardFontDataUrl } = resolvePdfjsAssetUrls()
    const fileData = source
      ? Buffer.from(await abortable(source.readBytes(), signal))
      : await readFile(filePath, { signal })
    signal?.throwIfAborted()
    const maxChars = options.maxChars ?? MAX_PDF_TEXT_CHARS

    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(fileData),
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0
    })
    let document: Awaited<typeof loadingTask.promise> | undefined
    let ocr: ReturnType<typeof createPdfOcrSession> | undefined
    let ocrClosing: Promise<void> | undefined
    const closeOcr = (): Promise<void> => (ocrClosing ??= ocr?.close() ?? Promise.resolve())
    let destruction: Promise<void> | undefined
    const destroy = (): Promise<void> =>
      (destruction ??= document ? document.destroy() : loadingTask.destroy())
    const aborted = (): void => {
      void closeOcr().catch(() => undefined)
      void destroy().catch(() => undefined)
    }
    signal?.addEventListener('abort', aborted, { once: true })
    const coverage = {
      textPages: [] as number[],
      ocrPages: [] as number[],
      unavailablePages: [] as number[],
      uncheckedPages: [] as number[],
      unverifiedPages: [] as number[]
    }
    try {
      document = await abortable(loadingTask.promise, signal)
      signal?.throwIfAborted()
      const createOcrSession = options.createOcrSession
        ? options.createOcrSession
        : options.ocr
          ? (await import('./pdf-ocr')).createPdfOcrSession
          : undefined
      signal?.throwIfAborted()
      ocr = options.ocr ? createOcrSession!() : undefined
      const pageTexts: string[] = []
      const pageStarts: { page: number; offset: number }[] = []
      const uncertainPages = new Set<number>()
      const pageLayouts: NonNullable<PdfTextResult['pageLayouts']>[number][] = []
      const layoutOmittedPages: number[] = []
      let layoutChars = 0
      let totalChars = 0
      let truncated = false
      const boundedTargetPage =
        targetPageNumber !== undefined && Number.isSafeInteger(targetPageNumber)
          ? Math.min(document.numPages, Math.max(1, targetPageNumber))
          : undefined
      const firstPage = boundedTargetPage ?? 1
      const lastPage = boundedTargetPage ?? document.numPages
      for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
        signal?.throwIfAborted()
        const marker = `--- Page ${pageNumber} ---\n`
        const remaining = maxChars - totalChars - (pageTexts.length ? 2 : 0)
        const page = await abortable(document.getPage(pageNumber), signal)
        let pageText: string
        try {
          const nativeText = await abortable(
            readPdfPageText(
              page,
              (number, layout) => {
                uncertainPages.add(number)
                if (!options.includeLayout) return
                const chars = layout ? JSON.stringify(layout).length : 0
                if (layout && layoutChars + chars <= maxChars) {
                  pageLayouts.push(layout)
                  layoutChars += chars
                } else layoutOmittedPages.push(number)
              },
              options.includeLayout
            ),
            signal
          )
          const operators = ocr ? await abortable(page.getOperatorList(), signal) : undefined
          const hasRaster = !!operators?.fnArray.some((op) =>
            [
              pdfjs.OPS.paintImageXObject,
              pdfjs.OPS.paintInlineImageXObject,
              pdfjs.OPS.paintImageMaskXObject,
              pdfjs.OPS.paintImageXObjectRepeat,
              pdfjs.OPS.paintImageMaskXObjectRepeat,
              pdfjs.OPS.paintInlineImageXObjectGroup,
              pdfjs.OPS.paintImageMaskXObjectGroup
            ].includes(op)
          )
          // Paths can encode outlined prose as well as plots. Do not infer completeness from text.
          const hasVector = !!operators?.fnArray.some((op) =>
            [pdfjs.OPS.constructPath, pdfjs.OPS.shadingFill].includes(op)
          )
          const hasPageContent = operators?.fnArray.length !== 0
          // A lone decimal label does not establish native body text. No density heuristics.
          const needsOcr =
            (hasPageContent && !nativeText) || (hasRaster && /^\d+$/.test(nativeText))
          const canOcr = ocr && needsOcr
          const bodyPrefixLength =
            marker.length + (canOcr && nativeText ? `${nativeText}\n\n[OCR]\n`.length : 0)
          if ((nativeText || canOcr) && remaining <= bodyPrefixLength) {
            // A prefix alone is not body evidence. Do not recognize text that cannot be returned.
            truncated = true
            coverage.uncheckedPages = Array.from(
              { length: lastPage - pageNumber + 1 },
              (_, i) => pageNumber + i
            )
            break
          }
          if (nativeText) coverage.textPages.push(pageNumber)
          if (hasRaster || hasVector) coverage.unverifiedPages.push(pageNumber)
          pageText = nativeText
          if (canOcr && ocr) {
            let recognized = ''
            try {
              recognized = await abortable(ocr.recognize(page), signal)
            } catch {
              signal?.throwIfAborted()
              // Preserve native labels; absent body text remains visible and retryable.
            }
            if (recognized) {
              coverage.ocrPages.push(pageNumber)
              pageText = nativeText ? `${nativeText}\n\n[OCR]\n${recognized}` : recognized
            } else coverage.unavailablePages.push(pageNumber)
          } else if (!nativeText) coverage.unavailablePages.push(pageNumber)
        } finally {
          page.cleanup()
        }

        if (!pageText) continue
        pageStarts.push({ page: pageNumber, offset: totalChars + (pageTexts.length ? 2 : 0) })
        const block = marker + pageText
        totalChars += block.length + (pageTexts.length ? 2 : 0)
        pageTexts.push(block)
        if (totalChars > maxChars) {
          truncated = true
          coverage.uncheckedPages = Array.from(
            { length: lastPage - pageNumber },
            (_, i) => pageNumber + i + 1
          )
          break
        }
      }

      let text = pageTexts.join('\n\n')
      if (text.length > maxChars) {
        text = text.slice(0, maxChars)
        truncated = true
      }
      const { unverifiedPages, ...pageCoverage } = coverage
      text = text.trim()
      const warnings = [...uncertainPages].map(
        (number) =>
          `Page ${number}: text layout remains uncertain; native reading order was retained.`
      )
      signal?.throwIfAborted()
      return {
        text,
        pageCount: document.numPages,
        truncated,
        ...(pageStarts.length
          ? { pageStarts: pageStarts.filter(({ offset }) => offset < text.length) }
          : {}),
        ...(warnings.length ? { warnings } : {}),
        ...(pageLayouts.length ? { pageLayouts } : {}),
        ...(layoutOmittedPages.length ? { layoutOmittedPages } : {}),
        coverage: { ...pageCoverage, ...(unverifiedPages.length ? { unverifiedPages } : {}) }
      }
    } finally {
      signal?.removeEventListener('abort', aborted)
      try {
        await closeOcr()
      } finally {
        await destroy()
      }
    }
  }, signal)
}

// Targeted counterpart used by Reviewer content reads. It shares the bounded extraction pool but
// asks pdfjs only for the requested pages and bounds the extracted text before it enters model context.
export const extractPdfTextPages = async (
  filePath: string,
  requestedPages?: number[],
  maxChars = MAX_PDF_TEXT_CHARS,
  signal?: AbortSignal
): Promise<TargetedPdfTextResult> => {
  signal?.throwIfAborted()
  const fileInfo = await stat(filePath)
  if (fileInfo.size > MAX_AUTO_EXTRACT_PDF_BYTES) {
    throw new Error(
      `PDF source is ${fileInfo.size} bytes, exceeding the automatic extraction limit.`
    )
  }
  return withPdfTextExtractionSlot(async () => {
    signal?.throwIfAborted()
    const { readPdfPageText } = await import('./pdf-reading-order')
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
    const { cMapUrl, standardFontDataUrl } = resolvePdfjsAssetUrls()
    const fileData = await readFile(filePath, { signal })
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(fileData),
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0
    })
    const document = await loadingTask.promise

    try {
      const selectedPages =
        requestedPages ?? Array.from({ length: document.numPages }, (_, index) => index + 1)
      const pages = [...new Set(selectedPages)]
      if (
        pages.some(
          (pageNumber) =>
            !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages
        )
      ) {
        throw new Error(`Requested PDF page must be between 1 and ${document.numPages}.`)
      }

      const pageTexts: TargetedPdfTextResult['pages'] = []
      let totalChars = 0
      let truncated = false
      for (const pageNumber of pages) {
        signal?.throwIfAborted()
        const page = await document.getPage(pageNumber)
        let pageText: string
        try {
          pageText = await readPdfPageText(page)
        } finally {
          page.cleanup()
        }
        const remaining = Math.max(0, maxChars - totalChars)
        pageTexts.push({ pageNumber, text: pageText.slice(0, remaining) })
        totalChars += pageText.length
        if (totalChars >= maxChars) {
          truncated = true
          break
        }
      }
      return { pages: pageTexts, pageCount: document.numPages, truncated }
    } finally {
      await document.destroy()
    }
  })
}
