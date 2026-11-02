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
import { readPdfPageText } from './pdf-reading-order'
import { createPdfOcrSession } from './pdf-ocr'

let activePdfTextExtractions = 0
const pendingPdfTextExtractions: Array<() => void> = []

const withPdfTextExtractionSlot = async <Result>(work: () => Promise<Result>): Promise<Result> => {
  if (activePdfTextExtractions >= MAX_CONCURRENT_PDF_TEXT_EXTRACTIONS) {
    await new Promise<void>((resolve) => pendingPdfTextExtractions.push(resolve))
  }
  activePdfTextExtractions += 1
  try {
    return await work()
  } finally {
    activePdfTextExtractions -= 1
    pendingPdfTextExtractions.shift()?.()
  }
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
  }> = {}
): Promise<PdfTextResult> => {
  const source = typeof targetPageOrSource === 'object' ? targetPageOrSource : undefined
  const targetPageNumber = typeof targetPageOrSource === 'number' ? targetPageOrSource : undefined
  const size = source?.size ?? (await stat(filePath)).size
  if (size > MAX_AUTO_EXTRACT_PDF_BYTES) {
    throw new Error(`PDF source is ${size} bytes, exceeding the automatic extraction limit.`)
  }
  return withPdfTextExtractionSlot(async () => {
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
    const { cMapUrl, standardFontDataUrl } = resolvePdfjsAssetUrls()
    const fileData = source ? Buffer.from(await source.readBytes()) : await readFile(filePath)
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
    const document = await loadingTask.promise

    const ocr = options.ocr ? (options.createOcrSession ?? createPdfOcrSession)() : undefined
    const coverage = {
      textPages: [] as number[],
      ocrPages: [] as number[],
      unavailablePages: [] as number[],
      uncheckedPages: [] as number[],
      unverifiedPages: [] as number[]
    }
    try {
      const pageTexts: string[] = []
      let totalChars = 0
      let truncated = false
      const boundedTargetPage =
        targetPageNumber !== undefined && Number.isSafeInteger(targetPageNumber)
          ? Math.min(document.numPages, Math.max(1, targetPageNumber))
          : undefined
      const firstPage = boundedTargetPage ?? 1
      const lastPage = boundedTargetPage ?? document.numPages
      for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
        const marker = `--- Page ${pageNumber} ---\n`
        const remaining = maxChars - totalChars - (pageTexts.length ? 2 : 0)
        const page = await document.getPage(pageNumber)
        let pageText: string
        try {
          const nativeText = await readPdfPageText(page)
          const operators = ocr ? await page.getOperatorList() : undefined
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
          if (canOcr) {
            let recognized = ''
            try {
              recognized = await ocr.recognize(page)
            } catch {
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
      return {
        text: text.trim(),
        pageCount: document.numPages,
        truncated,
        coverage: { ...pageCoverage, ...(unverifiedPages.length ? { unverifiedPages } : {}) }
      }
    } finally {
      try {
        await ocr?.close()
      } finally {
        await document.destroy()
      }
    }
  })
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
