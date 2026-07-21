import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Images larger than this are downscaled/re-encoded before inlining so a single upload never
// blows past the model's per-image (~5MB) and total-request (~32MB) limits after base64 growth.
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024

// A single image must stay under the provider per-image limit AFTER base64 growth. Anthropic rejects
// an image near 5MB and OpenCode's default image config caps base64 at 5MB (5242880); base64 inflates
// raw bytes ~33%. Cap the re-encoded raw payload at 3.5MB so its base64 form (~4.7MB) stays under 5MB
// on both routes — the previous 4.5MB raw grew to ~6MB base64 and could be rejected or force a re-resize.
export const MAX_IMAGE_PAYLOAD_BYTES = 3.5 * 1024 * 1024

// Base64 image data shares the request with prompts and tools. Keep 8MB of a typical 32MB request
// available for that non-image content even when the composer accepts its maximum attachment count.
export const MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES = 24 * 1024 * 1024

// Anthropic downscales images past 1568px on the long edge anyway, so this is a lossless-of-info cap.
const MAX_IMAGE_LONG_EDGE = 1568

// A conversation replays its full history every turn, so inlined image payloads accumulate across
// turns even though each image is individually capped. Once the running base64 total nears the
// provider's 32MB request ceiling, further images are sent as file references instead of base64.
// This bounds what one session can contribute so it never drives the request past the limit — which
// both fails the turn ("Request too large") and breaks compaction with `media_unstrippable`. Base64
// inflates ~33% and text/tool payloads share the request, so the budget sits well under 32MB.
export const MAX_SESSION_INLINE_IMAGE_BYTES = 20 * 1024 * 1024

// Whether another image may be inlined given how many base64 bytes this session has already inlined.
// The first image of a session always inlines (a lone image is per-image capped well under the limit),
// so a conversation is never left with zero visual content just because one image is large.
export const canInlineImageInSession = (
  alreadyInlinedBytes: number,
  imageBase64Length: number,
  budget: number = MAX_SESSION_INLINE_IMAGE_BYTES
): boolean => alreadyInlinedBytes === 0 || alreadyInlinedBytes + imageBase64Length <= budget

// Extracted PDF text is bounded so a huge document can never recreate the oversized-request problem.
export const MAX_PDF_TEXT_CHARS = 1024 * 1024

export type ImageContentData = {
  data: string
  mimeType: string
}

export type InlineImageBudget = {
  imageCount: number
  base64Bytes: number
}

export type ImageContentErrorCode =
  | 'IMAGE_DECODE_FAILED'
  | 'IMAGE_PROCESSING_FAILED'
  | 'IMAGE_PAYLOAD_TOO_LARGE'
  | 'IMAGE_TOTAL_BUDGET_EXCEEDED'

type ImageContentErrorDetails = {
  sourceBytes?: number
  payloadBytes?: number
  usedBytes?: number
  limitBytes?: number
  imageCount?: number
  cause?: unknown
}

export class ImageContentError extends Error {
  readonly code: ImageContentErrorCode
  readonly sourceBytes?: number
  readonly payloadBytes?: number
  readonly usedBytes?: number
  readonly limitBytes?: number
  readonly imageCount?: number

  constructor(
    code: ImageContentErrorCode,
    message: string,
    details: ImageContentErrorDetails = {}
  ) {
    super(message, { cause: details.cause })
    this.name = 'ImageContentError'
    this.code = code
    this.sourceBytes = details.sourceBytes
    this.payloadBytes = details.payloadBytes
    this.usedBytes = details.usedBytes
    this.limitBytes = details.limitBytes
    this.imageCount = details.imageCount
  }
}

export type PdfTextResult = {
  text: string
  pageCount: number
  truncated: boolean
}

// Accounts for the bytes that will actually be inserted into JSON rather than the decoded image
// size. Callers can fold this over prepared image blocks before dispatching a multimodal prompt.
export const consumeInlineImageBudget = (
  current: InlineImageBudget,
  image: ImageContentData
): InlineImageBudget => {
  const imageCount = current.imageCount + 1
  const payloadBytes = Buffer.byteLength(image.data, 'ascii')
  const usedBytes = current.base64Bytes + payloadBytes
  if (usedBytes > MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES) {
    throw new ImageContentError(
      'IMAGE_TOTAL_BUDGET_EXCEEDED',
      `Inline image data requires ${usedBytes} bytes, exceeding the ${MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES}-byte request budget.`,
      {
        payloadBytes,
        usedBytes,
        limitBytes: MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES,
        imageCount
      }
    )
  }

  return { imageCount, base64Bytes: usedBytes }
}

// Builds the base64 payload for an image content block, downscaling oversized images first.
// Small images pass through unchanged. Oversized images must be decoded and reduced below the hard
// payload limit; returning their original bytes would allow a 50MB upload to escape this boundary.
export const buildImageContentData = async (
  filePath: string,
  mimeType: string | undefined,
  size: number
): Promise<ImageContentData> => {
  const fallbackMimeType = mimeType ?? 'application/octet-stream'

  if (size <= MAX_INLINE_IMAGE_BYTES) {
    return { data: (await readFile(filePath)).toString('base64'), mimeType: fallbackMimeType }
  }

  let nativeImage: (typeof import('electron'))['nativeImage']
  try {
    const electron = await import('electron')
    nativeImage = electron.nativeImage
  } catch (error) {
    throw new ImageContentError(
      'IMAGE_PROCESSING_FAILED',
      `Image processing is unavailable for an oversized ${size}-byte image.`,
      { sourceBytes: size, limitBytes: MAX_IMAGE_PAYLOAD_BYTES, cause: error }
    )
  }

  try {
    const image = nativeImage.createFromPath(filePath)

    if (image.isEmpty()) {
      throw new ImageContentError(
        'IMAGE_DECODE_FAILED',
        `Could not decode oversized ${size}-byte image for safe inlining.`,
        { sourceBytes: size, limitBytes: MAX_IMAGE_PAYLOAD_BYTES }
      )
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

    if (buffer.byteLength > MAX_IMAGE_PAYLOAD_BYTES) {
      throw new ImageContentError(
        'IMAGE_PAYLOAD_TOO_LARGE',
        `Processed image is ${buffer.byteLength} bytes, exceeding the ${MAX_IMAGE_PAYLOAD_BYTES}-byte inline limit.`,
        {
          sourceBytes: size,
          payloadBytes: buffer.byteLength,
          limitBytes: MAX_IMAGE_PAYLOAD_BYTES
        }
      )
    }

    return { data: buffer.toString('base64'), mimeType: outMimeType }
  } catch (error) {
    if (error instanceof ImageContentError) throw error

    throw new ImageContentError(
      'IMAGE_PROCESSING_FAILED',
      `Failed to safely process oversized ${size}-byte image.`,
      { sourceBytes: size, limitBytes: MAX_IMAGE_PAYLOAD_BYTES, cause: error }
    )
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
