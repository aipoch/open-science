import { randomUUID } from 'node:crypto'
import { MAX_DECODED_IMAGE_PIXELS } from '../raster-image-safety'
import {
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  sanitizeAcpMessageImage,
  type AcpMessageImage
} from '../../shared/acp-image-contract'

/** Encodes transient image assets for Jev's System One image extension. */
export const prepareClassificationImages = async (
  candidates: readonly AcpMessageImage[],
  signal: AbortSignal
): Promise<Record<string, { type: 'image'; format: 'png'; data_base64: string }>> => {
  signal.throwIfAborted()
  if (candidates.length > MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE)
    throw new Error('Classification image count exceeds the request budget.')
  let bytes = 0
  const images = candidates.map((candidate) => {
    const image = sanitizeAcpMessageImage(candidate)
    if (!image) throw new Error('Invalid classification image.')
    bytes += image.byteLength
    if (bytes > MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE)
      throw new Error('Classification images exceed the request budget.')
    return image
  })
  const assets: Record<string, { type: 'image'; format: 'png'; data_base64: string }> = {}
  if (!images.length) return assets
  const { default: sharp } = await import('sharp')
  for (const image of images) {
    signal.throwIfAborted()
    const source = sharp(Buffer.from(image.data, 'base64'), {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_DECODED_IMAGE_PIXELS
    })
    const metadata = await source.metadata()
    if ((metadata.pages ?? 1) > 1)
      throw new Error('Animated classification images are unsupported.')
    // Jev requires 256–1568 per side and >= 78,400 pixels. Padding to 280 on short
    // sides preserves aspect ratio and satisfies the area minimum without cropping.
    const resized = await source
      .autoOrient()
      .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true })
    signal.throwIfAborted()
    const output = await sharp(resized.data)
      .extend({
        top: 0,
        left: 0,
        bottom: Math.max(0, 280 - resized.info.height),
        right: Math.max(0, 280 - resized.info.width),
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      })
      .png()
      .toBuffer()
    signal.throwIfAborted()
    assets[randomUUID()] = { type: 'image', format: 'png', data_base64: output.toString('base64') }
  }
  return assets
}
