import sharp from 'sharp'
import { exceedsDecodedImagePixelLimit, readRasterImageDimensions } from '../raster-image-safety'
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, type ImageRaster } from './contract'

export async function readImageRaster(
  input: Buffer,
  orient: boolean,
  beforeDecode?: (pixels: number) => Promise<void> | undefined
): Promise<ImageRaster> {
  if (!input.length || input.length > MAX_IMAGE_BYTES) throw new Error('Image byte limit exceeded.')
  const mime = (['image/png', 'image/jpeg', 'image/webp'] as const).find((type) => {
    const size = readRasterImageDimensions(input, type)
    return size && !exceedsDecodedImagePixelLimit(size, MAX_IMAGE_PIXELS)
  })
  if (!mime) throw new Error('Unsupported or oversized raster image.')
  const image = sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' })
  const metadata = await image.metadata()
  if ((metadata.pages ?? 1) !== 1) throw new Error('Animated images are not supported.')
  const reservation = beforeDecode?.(metadata.width * metadata.height)
  if (reservation) await reservation
  if (orient && metadata.orientation && metadata.orientation !== 1) {
    const { data, info } = await image.autoOrient().png().toBuffer({ resolveWithObject: true })
    if (data.length > MAX_IMAGE_BYTES) throw new Error('Oriented image exceeds the byte limit.')
    return { bytes: data, mime: 'image/png', width: info.width, height: info.height }
  }
  // Header inspection is insufficient: decode the complete bounded raster before publication.
  await image.raw().toBuffer()
  return { bytes: input, mime, ...metadata.autoOrient }
}
