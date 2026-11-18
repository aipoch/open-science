import sharp from 'sharp'
import type { ImageSpatialReference } from '../../shared/image-model-presets'
import { imageEditSnapshotSchema } from '../../shared/image-edit-contract'
import {
  ImageModelError,
  MAX_IMAGE_BYTES,
  type ImageRaster,
  type ImageSpatialInput
} from './contract'

const spatialSchema = imageEditSnapshotSchema.pick({ naturalSize: true, regions: true })
const MAX_GUIDE_EDGE = 1280

// Numbers and validated geometry alone enter SVG. User instructions never become SVG markup.
export async function annotateImageInput(
  source: ImageRaster,
  input: ImageSpatialInput,
  mode: ImageSpatialReference
): Promise<ImageRaster> {
  const parsed = spatialSchema.safeParse(input)
  if (
    !parsed.success ||
    parsed.data.naturalSize.width !== source.width ||
    parsed.data.naturalSize.height !== source.height
  )
    throw new ImageModelError(
      'UNSUPPORTED_OPTION',
      'Image regions do not match the oriented source dimensions.'
    )
  const { regions } = parsed.data
  const compactGuide = mode === 'separate-reference'
  const scale = compactGuide
    ? Math.min(1, MAX_GUIDE_EDGE / Math.max(source.width, source.height))
    : 1
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))
  const stroke = Math.max(2, Math.min(width, height) / 250)
  const radius = Math.max(6, Math.min(width, height) / 60)
  const pixel = (p: { x: number; y: number }): [number, number] => [
    p.x * (width - 1),
    p.y * (height - 1)
  ]
  const marks = regions
    .map(({ number, geometry }) => {
      let shape = ''
      let anchor: [number, number]
      if (geometry.kind === 'point') {
        anchor = pixel(geometry.point)
      } else if (geometry.kind === 'polygon') {
        anchor = pixel(geometry.points[0])
        shape = `<polygon points="${geometry.points.map((p) => pixel(p).join(',')).join(' ')}"/>`
      } else {
        anchor = pixel(geometry.start)
        const end = pixel(geometry.end)
        if (geometry.kind === 'rectangle') {
          shape = `<rect x="${anchor[0]}" y="${anchor[1]}" width="${end[0] - anchor[0]}" height="${end[1] - anchor[1]}"/>`
        } else {
          const angle = Math.atan2(end[1] - anchor[1], end[0] - anchor[0])
          const arms = [angle - Math.PI / 6, angle + Math.PI / 6].map(
            (a) => `${end[0] - radius * 2 * Math.cos(a)},${end[1] - radius * 2 * Math.sin(a)}`
          )
          shape = `<line x1="${anchor[0]}" y1="${anchor[1]}" x2="${end[0]}" y2="${end[1]}"/><polyline points="${arms[0]} ${end.join(',')} ${arms[1]}"/>`
        }
      }
      const isPoint = geometry.kind === 'point'
      const badgeRadius = isPoint ? radius * 1.25 : radius
      const [x, y] = anchor
      return `${shape}<circle cx="${x}" cy="${y}" r="${badgeRadius}" fill="${isPoint ? '#006c62' : '#ffffff'}" stroke="${isPoint ? '#ffffff' : '#006c62'}"/><text x="${x}" y="${y}" fill="${isPoint ? '#ffffff' : '#006c62'}" stroke="none" font-family="sans-serif" font-size="${badgeRadius * 1.4}" text-anchor="middle" dominant-baseline="central">${number}</text>`
    })
    .join('')
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g stroke="#006c62" stroke-width="${stroke}" fill="none">${marks}</g></svg>`
  )
  const raster = mode === 'markup' ? sharp(overlay) : sharp(source.bytes)
  if (scale < 1) raster.resize(width, height, { fit: 'fill' })
  if (compactGuide) raster.composite([{ input: overlay }])
  const bytes = await (compactGuide ? raster.jpeg({ quality: 82 }) : raster.png()).toBuffer()
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new ImageModelError('UNSUPPORTED_OPTION', 'Annotated image exceeds the input byte limit.')
  return { bytes, width, height, mime: compactGuide ? 'image/jpeg' : 'image/png' }
}
