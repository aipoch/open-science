import { readFile, stat } from 'node:fs/promises'
import { validatePdfProseRegions, type PdfProseRegion } from '../../shared/pdf-text'
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
  options: Readonly<{ maxChars?: number; proseRegions?: readonly PdfProseRegion[] }> = {}
): Promise<PdfTextResult> => {
  if (options.proseRegions !== undefined) validatePdfProseRegions(options.proseRegions)
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
      if (options.proseRegions?.some((region) => region.page < firstPage || region.page > lastPage))
        throw new Error(
          'PDF_READING_REGION_INVALID: A region page is outside the requested PDF pages.'
        )
      for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
        const page = await document.getPage(pageNumber)
        let pageText: string
        try {
          pageText = await readPdfPageText(
            page,
            options.proseRegions?.filter((region) => region.page === pageNumber)
          )
        } finally {
          page.cleanup()
        }

        if (!pageText) continue

        const block = `--- Page ${pageNumber} ---\n${pageText}`
        pageTexts.push(block)
        totalChars += block.length
        if (totalChars >= maxChars) {
          truncated = true
          break
        }
      }

      let text = pageTexts.join('\n\n')
      if (text.length > maxChars) {
        text = text.slice(0, maxChars)
        truncated = true
      }
      return { text: text.trim(), pageCount: document.numPages, truncated }
    } finally {
      await document.destroy()
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
