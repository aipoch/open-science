import { exceedsDecodedImagePixelLimit, MAX_DECODED_IMAGE_PIXELS } from './raster-image-safety'

export const MAX_PREVIEW_SOURCE_PIXELS = 64_000_000
const MAX_SOURCE_BYTES = 50 * 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_RETAINED_BYTES = 128 * 1024 * 1024
const MAX_PENDING_CONVERSIONS = 9

export type ResizedImagePreview = {
  data: Buffer
  width: number
  height: number
  release: () => void
}

// Shared by all resource owners: waiting requests hold no source or decoded image buffers.
let pending = 0
let retainedBytes = 0
let tail = Promise.resolve()

const isAnimatedPng = (source: Buffer): boolean => {
  if (!source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false
  // libvips decodes APNG's default frame only; do not silently turn an animation into a still.
  for (let offset = 8; offset + 12 <= source.byteLength;) {
    const length = source.readUInt32BE(offset)
    if (length > source.byteLength - offset - 12) return false
    const type = source.toString('ascii', offset + 4, offset + 8)
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
    offset += length + 12
  }
  return false
}

export const resizeImagePreview = async (
  size: number,
  readSource: () => Promise<Buffer>
): Promise<ResizedImagePreview> => {
  if (size > MAX_SOURCE_BYTES) throw new Error('Image preview source exceeds the 50 MiB limit.')
  if (pending >= MAX_PENDING_CONVERSIONS) throw new Error('Image preview capacity is busy.')
  pending += 1
  const previous = tail
  let advance!: () => void
  tail = new Promise<void>((resolve) => {
    advance = resolve
  })
  await previous
  let reserved = 0
  try {
    if (retainedBytes + MAX_OUTPUT_BYTES > MAX_RETAINED_BYTES) {
      throw new Error('Image preview capacity is busy.')
    }
    retainedBytes += MAX_OUTPUT_BYTES
    reserved = MAX_OUTPUT_BYTES
    const source = await readSource()
    if (source.byteLength !== size) throw new Error('Image preview changed while reading.')
    if (isAnimatedPng(source)) {
      throw new Error('Animated image preview exceeds the 16,000,000-pixel limit.')
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
        throw new Error('Animated image preview exceeds the 16,000,000-pixel limit.')
      }
      const dimensions = metadata.autoOrient
      const scale = Math.min(
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
      if (exceedsDecodedImagePixelLimit(result.info) || result.data.byteLength > MAX_OUTPUT_BYTES) {
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
        error instanceof Error &&
        /^(Animated image preview|Image preview output)/.test(error.message)
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
    advance()
  }
}
