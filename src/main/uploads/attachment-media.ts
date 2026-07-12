import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Images larger than this are downscaled/re-encoded before inlining so a single upload never
// blows past the model's per-image (~5MB) and total-request (~32MB) limits after base64 growth.
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024

// Anthropic rejects a single image whose payload exceeds 5MB; stay comfortably under it.
const MAX_IMAGE_PAYLOAD_BYTES = 4.5 * 1024 * 1024

// Anthropic downscales images past 1568px on the long edge anyway, so this is a lossless-of-info cap.
const MAX_IMAGE_LONG_EDGE = 1568

// Extracted PDF text is bounded so a huge document can never recreate the oversized-request problem.
export const MAX_PDF_TEXT_CHARS = 1024 * 1024

export type ImageContentData = {
  data: string
  mimeType: string
}

export type PdfTextResult = {
  text: string
  pageCount: number
  truncated: boolean
}

// Builds the base64 payload for an image content block, downscaling oversized images first.
// Small images and anything we cannot decode fall back to the raw bytes so behavior is unchanged.
export const buildImageContentData = async (
  filePath: string,
  mimeType: string | undefined,
  size: number
): Promise<ImageContentData> => {
  const fallbackMimeType = mimeType ?? 'application/octet-stream'

  if (size <= MAX_INLINE_IMAGE_BYTES) {
    return { data: (await readFile(filePath)).toString('base64'), mimeType: fallbackMimeType }
  }

  try {
    const { nativeImage } = await import('electron')
    const image = nativeImage.createFromPath(filePath)

    // A non-decodable or empty image cannot be compressed; send the original and let the API judge it.
    if (image.isEmpty()) {
      return { data: (await readFile(filePath)).toString('base64'), mimeType: fallbackMimeType }
    }

    const { width, height } = image.getSize()
    const longEdge = Math.max(width, height)
    const scale = longEdge > MAX_IMAGE_LONG_EDGE ? MAX_IMAGE_LONG_EDGE / longEdge : 1
    const resized =
      scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
            quality: 'better'
          })
        : image

    // PNGs keep transparency on the first pass; everything else re-encodes to JPEG for size.
    const preferPng = mimeType === 'image/png'
    let outMimeType = preferPng ? 'image/png' : 'image/jpeg'
    let buffer = preferPng ? resized.toPNG() : resized.toJPEG(80)

    // Progressive fallbacks keep the payload under the per-image limit for stubborn inputs.
    if (buffer.byteLength > MAX_IMAGE_PAYLOAD_BYTES) {
      outMimeType = 'image/jpeg'
      buffer = resized.toJPEG(70)
    }
    if (buffer.byteLength > MAX_IMAGE_PAYLOAD_BYTES) {
      const smaller = resized.resize({ width: 1024, quality: 'better' })
      buffer = smaller.toJPEG(65)
    }

    return { data: buffer.toString('base64'), mimeType: outMimeType }
  } catch {
    // If image processing is unavailable (e.g. no Electron runtime), fall back to the raw bytes.
    return { data: (await readFile(filePath)).toString('base64'), mimeType: fallbackMimeType }
  }
}

// Resolves the on-disk pdfjs asset directories so CID/CJK fonts map to Unicode during extraction.
const resolvePdfjsAssetUrls = (): { cMapUrl: string; standardFontDataUrl: string } => {
  const require = createRequire(import.meta.url)
  const packageDir = dirname(require.resolve('pdfjs-dist/package.json'))

  return {
    cMapUrl: `${pathToFileURL(join(packageDir, 'cmaps')).href}/`,
    standardFontDataUrl: `${pathToFileURL(join(packageDir, 'standard_fonts')).href}/`
  }
}

// Extracts selectable text from a PDF so the model receives readable content instead of the raw
// (base64) file, which would otherwise overflow the request size limit.
export const extractPdfText = async (filePath: string): Promise<PdfTextResult> => {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
  const { cMapUrl, standardFontDataUrl } = resolvePdfjsAssetUrls()
  const fileData = await readFile(filePath)

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

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      page.cleanup()

      const pageText = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
        .trim()

      // Skip empty pages so a scanned/image-only PDF yields no text and hits the caller's fallback.
      if (!pageText) continue

      const block = `--- Page ${pageNumber} ---\n${pageText}`
      pageTexts.push(block)
      totalChars += block.length

      if (totalChars >= MAX_PDF_TEXT_CHARS) {
        truncated = true
        break
      }
    }

    let text = pageTexts.join('\n\n')
    if (text.length > MAX_PDF_TEXT_CHARS) {
      text = text.slice(0, MAX_PDF_TEXT_CHARS)
      truncated = true
    }

    return { text: text.trim(), pageCount: document.numPages, truncated }
  } finally {
    await document.destroy()
  }
}
