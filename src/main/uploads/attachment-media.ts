import { createRequire } from 'node:module'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Sharp } from 'sharp'

// Images larger than this are downscaled/re-encoded before inlining so a single upload never
// blows past the model's per-image (~5MB) and total-request (~32MB) limits after base64 growth.
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024

// Source files above these limits stay as resource links. They must never be decoded/read in full in
// the main process merely because the managed upload storage now accepts multi-gigabyte files.
export const MAX_AUTO_PROCESS_IMAGE_BYTES = 50 * 1024 * 1024
export const MAX_AUTO_EXTRACT_PDF_BYTES = 50 * 1024 * 1024

// A single image must stay under the provider per-image limit AFTER base64 growth. Anthropic rejects
// an image near 5MB and OpenCode's default image config caps base64 at 5MB (5242880); base64 inflates
// raw bytes ~33%. Cap the re-encoded raw payload at 3.5MB so its base64 form (~4.7MB) stays under 5MB
// on both routes — the previous 4.5MB raw grew to ~6MB base64 and could be rejected or force a re-resize.
export const MAX_IMAGE_PAYLOAD_BYTES = 3.5 * 1024 * 1024

// Base64 image data shares the request with prompts and tools. Keep 8MB of a typical 32MB request
// available for that non-image content even when the composer accepts its maximum attachment count.
export const MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES = 24 * 1024 * 1024

// Anthropic downscales images past 1568px on the long edge anyway, so this is a lossless-of-info cap.
export const MAX_IMAGE_LONG_EDGE = 1568

// Keep the cheap PNG/JPEG header preflight in front of sharp's decoder-side pixel limit so
// malformed or oversized inputs fail before native decoding and allocation. 16 MP is at most
// ~64 MiB at four bytes per pixel, which bounds processing independently of compressed size.
export const MAX_DECODED_IMAGE_PIXELS = 16_000_000

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

export type ImagePixelRect = {
  left: number
  top: number
  right: number
  bottom: number
}

export type ImageCrop =
  ({ unit: 'pixels' } & ImagePixelRect) | ({ unit: 'fraction' } & ImagePixelRect)

export type PreparedImageContentData = Omit<ImageContentData, 'mimeType'> & {
  mimeType: 'image/png' | 'image/jpeg'
  originalSize: { width: number; height: number }
  crop?: ImagePixelRect
  outputSize: { width: number; height: number }
}

export type InlineImageBudget = {
  imageCount: number
  base64Bytes: number
}

export type ImageContentErrorCode =
  | 'IMAGE_DECODE_FAILED'
  | 'IMAGE_PROCESSING_FAILED'
  | 'IMAGE_PAYLOAD_TOO_LARGE'
  | 'IMAGE_SOURCE_TOO_LARGE'
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

export type AttachmentByteSource = {
  size: number
  readBytes: () => Promise<Uint8Array>
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

const detectedImageMimeType = (bytes: Buffer): 'image/png' | 'image/jpeg' | undefined => {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    ? 'image/jpeg'
    : undefined
}

type ImageDimensions = { width: number; height: number }

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

const declaredPngDimensions = (bytes: Buffer): ImageDimensions | undefined => {
  if (
    bytes.length < 33 ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return undefined
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const declaredJpegDimensions = (bytes: Buffer): ImageDimensions | undefined => {
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) return undefined

    const marker = bytes[offset]
    offset += 1
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0xda ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      return undefined
    }
    if (offset + 2 > bytes.length) return undefined

    const segmentLength = bytes.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 11) return undefined
      const samplePrecision = bytes[offset + 2]
      const componentCount = bytes[offset + 7]
      if (samplePrecision === 0 || componentCount < 1 || segmentLength !== 8 + 3 * componentCount) {
        return undefined
      }
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3)
      }
    }
    offset += segmentLength
  }
  return undefined
}

const declaredImageDimensions = (
  bytes: Buffer,
  mimeType: 'image/png' | 'image/jpeg'
): ImageDimensions => {
  const dimensions =
    mimeType === 'image/png' ? declaredPngDimensions(bytes) : declaredJpegDimensions(bytes)
  if (!dimensions) {
    throw new ImageContentError(
      'IMAGE_DECODE_FAILED',
      'Could not read the image dimensions safely.'
    )
  }
  return dimensions
}

const assertImagePixelLimit = (size: ImageDimensions): void => {
  if (
    size.width < 1 ||
    size.height < 1 ||
    size.width > Math.floor(MAX_DECODED_IMAGE_PIXELS / size.height)
  ) {
    throw new ImageContentError(
      'IMAGE_PROCESSING_FAILED',
      `Decoded image exceeds the ${MAX_DECODED_IMAGE_PIXELS}-pixel processing limit.`
    )
  }
}

const resolvedCrop = (
  crop: ImageCrop | undefined,
  size: { width: number; height: number }
): ImagePixelRect | undefined => {
  if (!crop) return undefined
  const values = [crop.left, crop.top, crop.right, crop.bottom]
  if (
    values.some((value) => !Number.isFinite(value)) ||
    (crop.unit === 'pixels' && values.some((value) => !Number.isInteger(value))) ||
    (crop.unit === 'fraction' && values.some((value) => value < 0 || value > 1))
  ) {
    throw new ImageContentError('IMAGE_PROCESSING_FAILED', 'Image crop coordinates are invalid.')
  }
  const rect =
    crop.unit === 'fraction'
      ? {
          left: Math.floor(crop.left * size.width),
          top: Math.floor(crop.top * size.height),
          right: Math.ceil(crop.right * size.width),
          bottom: Math.ceil(crop.bottom * size.height)
        }
      : { left: crop.left, top: crop.top, right: crop.right, bottom: crop.bottom }
  if (
    rect.left < 0 ||
    rect.top < 0 ||
    rect.right > size.width ||
    rect.bottom > size.height ||
    rect.left >= rect.right ||
    rect.top >= rect.bottom
  ) {
    throw new ImageContentError(
      'IMAGE_PROCESSING_FAILED',
      'Image crop is outside the image bounds.'
    )
  }
  return rect
}

type ImageSourcePolicy = 'png-jpeg-only' | 'sharp-raster'

const processImageBytes = async (
  bytes: Buffer,
  sourcePolicy: ImageSourcePolicy,
  options: { crop?: ImageCrop; maxSize?: number } = {},
  signal?: AbortSignal
): Promise<PreparedImageContentData> => {
  if (sourcePolicy === 'png-jpeg-only') {
    const mimeType = detectedImageMimeType(bytes)
    if (!mimeType) {
      throw new ImageContentError(
        'IMAGE_DECODE_FAILED',
        'Only PNG and JPEG image sources are supported.'
      )
    }
    assertImagePixelLimit(declaredImageDimensions(bytes, mimeType))
  }

  const { default: sharp } = await import('sharp')
  const inputOptions = {
    failOn: 'error' as const,
    limitInputPixels: MAX_DECODED_IMAGE_PIXELS,
    sequentialRead: true
  }
  const source = sharp(bytes, inputOptions)
  const metadata = await source.metadata().catch((error: unknown) => {
    throw new ImageContentError('IMAGE_DECODE_FAILED', 'Could not decode the image source.', {
      cause: error
    })
  })
  signal?.throwIfAborted()
  const originalSize = metadata.autoOrient ?? {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0
  }
  assertImagePixelLimit(originalSize)

  const crop = resolvedCrop(options.crop, originalSize)
  const croppedSize = crop
    ? { width: crop.right - crop.left, height: crop.bottom - crop.top }
    : originalSize
  const maxSize = options.maxSize ?? MAX_IMAGE_LONG_EDGE
  const scale = Math.min(1, maxSize / Math.max(croppedSize.width, croppedSize.height))
  let outputSize = {
    width: Math.max(1, Math.round(croppedSize.width * scale)),
    height: Math.max(1, Math.round(croppedSize.height * scale))
  }
  const prepare = (size: ImageDimensions = outputSize): Sharp => {
    let pipeline = source.clone().autoOrient()
    if (crop) {
      pipeline = pipeline.extract({
        left: crop.left,
        top: crop.top,
        width: croppedSize.width,
        height: croppedSize.height
      })
    }
    if (size.width !== croppedSize.width || size.height !== croppedSize.height) {
      pipeline = pipeline.resize(size.width, size.height, {
        fit: 'fill',
        kernel: 'lanczos3',
        withoutEnlargement: true
      })
    }
    return pipeline
  }
  let preserveTransparency = false
  if (metadata.hasAlpha === true) {
    const { data, info } = await prepare().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const alphaChannel = info.channels - 1
    for (let offset = alphaChannel; offset < data.length; offset += info.channels) {
      if (data[offset] !== 0xff) {
        preserveTransparency = true
        break
      }
    }
  }
  signal?.throwIfAborted()
  const outputMimeType: 'image/png' | 'image/jpeg' = preserveTransparency
    ? 'image/png'
    : 'image/jpeg'
  let buffer =
    outputMimeType === 'image/png'
      ? await prepare().png().toBuffer()
      : await prepare().jpeg({ quality: 80 }).toBuffer()
  if (outputMimeType === 'image/png' && buffer.byteLength > MAX_IMAGE_PAYLOAD_BYTES) {
    // Transparent output cannot fall back to JPEG. Reduce dimensions to a size whose raw RGBA
    // pixels fit below the inline payload limit even when PNG compression is ineffective.
    const fallbackScale = Math.min(1, 768 / Math.max(outputSize.width, outputSize.height))
    if (fallbackScale < 1) {
      outputSize = {
        width: Math.max(1, Math.round(outputSize.width * fallbackScale)),
        height: Math.max(1, Math.round(outputSize.height * fallbackScale))
      }
    }
    buffer = await prepare().png().toBuffer()
  } else if (buffer.byteLength > MAX_IMAGE_PAYLOAD_BYTES) {
    buffer = await prepare().jpeg({ quality: 70 }).toBuffer()
    if (buffer.byteLength > MAX_IMAGE_PAYLOAD_BYTES) {
      const fallbackScale = Math.min(1, 1024 / Math.max(outputSize.width, outputSize.height))
      if (fallbackScale < 1) {
        outputSize = {
          width: Math.max(1, Math.round(outputSize.width * fallbackScale)),
          height: Math.max(1, Math.round(outputSize.height * fallbackScale))
        }
      }
      buffer = await prepare().jpeg({ quality: 65 }).toBuffer()
    }
  }
  if (buffer.byteLength > MAX_IMAGE_PAYLOAD_BYTES) {
    throw new ImageContentError(
      'IMAGE_PAYLOAD_TOO_LARGE',
      `Processed image is ${buffer.byteLength} bytes, exceeding the ${MAX_IMAGE_PAYLOAD_BYTES}-byte inline limit.`,
      { payloadBytes: buffer.byteLength, limitBytes: MAX_IMAGE_PAYLOAD_BYTES }
    )
  }

  signal?.throwIfAborted()

  return {
    data: buffer.toString('base64'),
    mimeType: outputMimeType,
    originalSize,
    ...(crop ? { crop } : {}),
    outputSize
  }
}

export const prepareImageContentData = async (
  filePath: string,
  options: { crop?: ImageCrop; maxSize?: number } = {},
  signal?: AbortSignal,
  expectedCanonicalPath?: string
): Promise<PreparedImageContentData> => {
  signal?.throwIfAborted()
  if (
    options.maxSize !== undefined &&
    (!Number.isInteger(options.maxSize) ||
      options.maxSize < 1 ||
      options.maxSize > MAX_IMAGE_LONG_EDGE)
  ) {
    throw new ImageContentError(
      'IMAGE_PROCESSING_FAILED',
      `Image maxSize must be an integer between 1 and ${MAX_IMAGE_LONG_EDGE}.`
    )
  }
  const canonicalPath = expectedCanonicalPath ?? (await realpath(filePath))
  const handle = await open(canonicalPath, 'r')
  try {
    // Workspace authorization supplies the exact canonical path it approved. Open that spelling,
    // then re-resolve it before reading. A file or parent-directory symlink swap before open changes
    // the second realpath; a swap after this check cannot change the already-open file.
    if ((await realpath(canonicalPath)) !== canonicalPath) {
      throw new ImageContentError(
        'IMAGE_PROCESSING_FAILED',
        'Image source changed while it was being opened.'
      )
    }
    const fileInfo = await handle.stat()
    const currentInfo = await stat(canonicalPath)
    if (fileInfo.dev !== currentInfo.dev || fileInfo.ino !== currentInfo.ino) {
      throw new ImageContentError(
        'IMAGE_PROCESSING_FAILED',
        'Image source changed while it was being opened.'
      )
    }
    if (!fileInfo.isFile()) {
      throw new ImageContentError('IMAGE_PROCESSING_FAILED', 'Image source is not a regular file.')
    }
    if (fileInfo.size > MAX_AUTO_PROCESS_IMAGE_BYTES) {
      throw new ImageContentError(
        'IMAGE_SOURCE_TOO_LARGE',
        `Image source is ${fileInfo.size} bytes, exceeding the automatic processing limit.`,
        { sourceBytes: fileInfo.size, limitBytes: MAX_AUTO_PROCESS_IMAGE_BYTES }
      )
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength > MAX_AUTO_PROCESS_IMAGE_BYTES) {
      throw new ImageContentError(
        'IMAGE_SOURCE_TOO_LARGE',
        `Image source is ${bytes.byteLength} bytes, exceeding the automatic processing limit.`,
        { sourceBytes: bytes.byteLength, limitBytes: MAX_AUTO_PROCESS_IMAGE_BYTES }
      )
    }
    signal?.throwIfAborted()
    try {
      return await processImageBytes(bytes, 'png-jpeg-only', options, signal)
    } catch (error) {
      if (error instanceof ImageContentError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ImageContentError('IMAGE_DECODE_FAILED', 'Could not decode the image source.', {
        cause: error
      })
    }
  } finally {
    await handle.close()
  }
}

// Builds the base64 payload for an image content block, downscaling oversized images first.
// Small images pass through unchanged. Oversized images must be decoded and reduced below the hard
// payload limit; returning their original bytes would allow a 50MB upload to escape this boundary.
export const buildImageContentData = async (
  filePath: string,
  mimeType: string | undefined,
  size: number,
  readBytes?: () => Promise<Uint8Array>
): Promise<ImageContentData> => {
  const fallbackMimeType = mimeType ?? 'application/octet-stream'

  if (size > MAX_AUTO_PROCESS_IMAGE_BYTES) {
    throw new ImageContentError(
      'IMAGE_SOURCE_TOO_LARGE',
      `Image source is ${size} bytes, exceeding the automatic processing limit.`,
      { sourceBytes: size, limitBytes: MAX_AUTO_PROCESS_IMAGE_BYTES }
    )
  }

  if (size <= MAX_INLINE_IMAGE_BYTES) {
    const source = readBytes ? Buffer.from(await readBytes()) : await readFile(filePath)
    return { data: source.toString('base64'), mimeType: fallbackMimeType }
  }

  try {
    // Managed versions supply integrity-checked bytes; legacy callers still read the resolved path.
    const bytes = readBytes ? Buffer.from(await readBytes()) : await readFile(filePath)
    if (bytes.byteLength > MAX_AUTO_PROCESS_IMAGE_BYTES) {
      throw new ImageContentError(
        'IMAGE_SOURCE_TOO_LARGE',
        `Image source is ${bytes.byteLength} bytes, exceeding the automatic processing limit.`,
        { sourceBytes: bytes.byteLength, limitBytes: MAX_AUTO_PROCESS_IMAGE_BYTES }
      )
    }
    const processed = await processImageBytes(bytes, 'sharp-raster')
    return { data: processed.data, mimeType: processed.mimeType }
  } catch (error) {
    if (error instanceof ImageContentError) {
      throw new ImageContentError(error.code, error.message, {
        sourceBytes: error.sourceBytes ?? size,
        payloadBytes: error.payloadBytes,
        usedBytes: error.usedBytes,
        limitBytes: error.limitBytes ?? MAX_IMAGE_PAYLOAD_BYTES,
        imageCount: error.imageCount,
        cause: error.cause
      })
    }

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
export const extractPdfText = async (
  filePath: string,
  source?: AttachmentByteSource
): Promise<PdfTextResult> => {
  const size = source?.size ?? (await stat(filePath)).size
  if (size > MAX_AUTO_EXTRACT_PDF_BYTES) {
    throw new Error(`PDF source is ${size} bytes, exceeding the automatic extraction limit.`)
  }
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
  const { cMapUrl, standardFontDataUrl } = resolvePdfjsAssetUrls()
  const fileData = source ? Buffer.from(await source.readBytes()) : await readFile(filePath)

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
