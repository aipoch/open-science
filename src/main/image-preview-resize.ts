import { IMAGE_PREVIEW_BUSY_MESSAGE } from '../shared/preview-resources'
import {
  isAnimatedPng,
  exceedsDecodedImagePixelLimit,
  MAX_DECODED_IMAGE_PIXELS
} from './raster-image-safety'

export const MAX_PREVIEW_SOURCE_PIXELS = 64_000_000
export const IMAGE_THUMBNAIL_EDGE = 192
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_RETAINED_BYTES = 128 * 1024 * 1024
const MAX_PENDING_CONVERSIONS = 9

export type ResizedImagePreview = {
  data: Buffer
  width: number
  height: number
  release: () => void
}

export class AnimatedImagePreviewError extends Error {
  constructor() {
    super('Animated image preview exceeds the 16,000,000-pixel limit.')
  }
}

// Shared by all resource owners: waiting requests hold no source or decoded image buffers.
let pending = 0
let retainedBytes = 0
const waitingPreviews: Array<() => void> = []
const waitingThumbnails: Array<() => void> = []

export const resizeImagePreview = async (
  size: number,
  readSource: () => Promise<Buffer>,
  thumbnail = false
): Promise<ResizedImagePreview> => {
  const outputBudget = thumbnail ? 512 * 1024 : MAX_OUTPUT_BYTES
  if (size > MAX_SOURCE_BYTES)
    throw new Error(
      `Image preview source exceeds the ${MAX_SOURCE_BYTES / (1024 * 1024)} MiB limit.`
    )
  // Keep one position available when a grid fills the queue with thumbnails.
  if (pending >= MAX_PENDING_CONVERSIONS - (thumbnail ? 1 : 0))
    throw new Error(IMAGE_PREVIEW_BUSY_MESSAGE)
  pending += 1
  if (pending > 1) {
    const waiting = thumbnail ? waitingThumbnails : waitingPreviews
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  let reserved = 0
  try {
    if (retainedBytes + outputBudget > MAX_RETAINED_BYTES) {
      throw new Error(IMAGE_PREVIEW_BUSY_MESSAGE)
    }
    retainedBytes += outputBudget
    reserved = outputBudget
    const source = await readSource()
    if (source.byteLength !== size) throw new Error('Image preview changed while reading.')
    if (isAnimatedPng(source)) {
      throw new AnimatedImagePreviewError()
    }
    const { default: sharp } = await import('sharp')
    const image = sharp(source, {
      failOn: 'warning',
      limitInputPixels: MAX_PREVIEW_SOURCE_PIXELS,
      sequentialRead: true
    }).timeout({ seconds: 30 })
    try {
      const metadata = await image.metadata()
      if ((metadata.pages ?? 1) > 1) {
        throw new AnimatedImagePreviewError()
      }
      const dimensions = metadata.autoOrient
      const scale = Math.min(
        thumbnail ? IMAGE_THUMBNAIL_EDGE / Math.max(dimensions.width, dimensions.height) : 1,
        1,
        Math.sqrt(MAX_DECODED_IMAGE_PIXELS / (dimensions.width * dimensions.height))
      )
      const width = Math.max(1, Math.floor(dimensions.width * scale))
      const height = Math.max(1, Math.floor(dimensions.height * scale))
      // Extreme aspect ratios still need the product check after clamping either dimension to one.
      const result = await image
        .autoOrient()
        .resize(
          Math.min(width, MAX_DECODED_IMAGE_PIXELS),
          Math.min(height, MAX_DECODED_IMAGE_PIXELS),
          {
            fit: 'inside',
            withoutEnlargement: true
          }
        )
        .png()
        .toBuffer({ resolveWithObject: true })
      if (exceedsDecodedImagePixelLimit(result.info) || result.data.byteLength > outputBudget) {
        throw new Error('Image preview output exceeds its safety limit.')
      }
      retainedBytes -= reserved - result.data.byteLength
      reserved = 0
      let released = false
      return {
        data: result.data,
        width: result.info.width,
        height: result.info.height,
        release: () => {
          if (released) return
          released = true
          retainedBytes -= result.data.byteLength
        }
      }
    } catch (error) {
      if (
        error instanceof AnimatedImagePreviewError ||
        (error instanceof Error && error.message.startsWith('Image preview output'))
      ) {
        throw error
      }
      throw new Error('Image preview could not be decoded or resized.', { cause: error })
    } finally {
      image.destroy()
    }
  } finally {
    retainedBytes -= reserved
    pending -= 1
    const advance = waitingPreviews.shift() ?? waitingThumbnails.shift()
    advance?.()
  }
}
