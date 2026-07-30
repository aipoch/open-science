import { decode, type TiffIfd } from 'tiff'

import {
  DEFAULT_TIFF_PREVIEW_LIMITS,
  type DecodedTiffPage,
  type TiffPreviewLimits
} from './tiff-preview-types'
import { assertTiffCompressionSafe, inspectTiffStructure } from './tiff-preview-preflight'

const MAX_TIFF_DIMENSION = 16_384
const TIFF_DECOMPRESSOR_SCRATCH_BYTES = 64 * 1024 * 1024

type SampleRange = { minimum: number; maximum: number }

const sampleToByte = (value: number, range: SampleRange): number => {
  if (!Number.isFinite(value)) return 0
  const { minimum, maximum } = range
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) return 0

  const normalized = (Math.max(minimum, Math.min(maximum, value)) - minimum) / (maximum - minimum)
  return Math.round(normalized * 255)
}

const getTaggedSampleValues = (value: unknown, componentIndices: number[]): number[] => {
  if (typeof value === 'number') return Number.isFinite(value) ? [value] : []
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return []

  const values = Array.from(value as ArrayLike<number>)
  return componentIndices
    .map((componentIndex) => values[componentIndex] ?? values[0])
    .filter((candidate): candidate is number =>
      typeof candidate === 'number' ? Number.isFinite(candidate) : false
    )
}

const getSampleRange = (ifd: TiffIfd, componentIndices: number[]): SampleRange => {
  if (ifd.sampleFormat !== 3) return { minimum: 0, maximum: ifd.maxSampleValue }

  const taggedMinimums = getTaggedSampleValues(ifd.get('SMinSampleValue'), componentIndices)
  const taggedMaximums = getTaggedSampleValues(ifd.get('SMaxSampleValue'), componentIndices)
  if (taggedMinimums.length > 0 && taggedMaximums.length > 0) {
    const minimum = Math.min(...taggedMinimums)
    const maximum = Math.max(...taggedMaximums)
    if (maximum > minimum) return { minimum, maximum }
  }

  let observedMinimum = Number.POSITIVE_INFINITY
  let observedMaximum = Number.NEGATIVE_INFINITY
  for (let pixel = 0; pixel < ifd.size; pixel += 1) {
    for (const componentIndex of componentIndices) {
      const sample = ifd.data[pixel * ifd.components + componentIndex]
      if (!Number.isFinite(sample)) continue
      observedMinimum = Math.min(observedMinimum, sample)
      observedMaximum = Math.max(observedMaximum, sample)
    }
  }

  if (observedMinimum >= 0 && observedMaximum <= 1) return { minimum: 0, maximum: 1 }
  if (observedMaximum > observedMinimum) {
    return { minimum: observedMinimum, maximum: observedMaximum }
  }
  if (observedMaximum > 0) return { minimum: 0, maximum: observedMaximum }
  if (observedMinimum < 0) return { minimum: observedMinimum, maximum: 0 }
  return { minimum: 0, maximum: 1 }
}

const getBytesPerSample = (ifd: TiffIfd): number => {
  if (ifd.sampleFormat === 1) {
    if (ifd.bitsPerSample === 1 || ifd.bitsPerSample === 8) return 1
    if (ifd.bitsPerSample === 16) return 2
  }
  if (ifd.sampleFormat === 3) {
    if (ifd.bitsPerSample === 32) return 4
    if (ifd.bitsPerSample === 64) return 8
  }
  throw new Error('Unsupported TIFF sample layout')
}

const assertSupportedColorLayout = (ifd: TiffIfd): void => {
  // tiff@7.1.3 applies integer-style WhiteIsZero inversion to Float32 samples, which loses
  // precision before returning the decoded data. Reject this layout instead of rendering it wrong.
  if (ifd.type === 0 && ifd.sampleFormat === 3) {
    throw new Error('Unsupported TIFF floating-point WhiteIsZero layout')
  }
  const grayscale =
    (ifd.type === 0 || ifd.type === 1) && (ifd.components === 1 || ifd.components === 2)
  const rgb = ifd.type === 2 && (ifd.components === 3 || ifd.components === 4)
  const palette = ifd.type === 3 && ifd.components === 1
  if (!grayscale && !rgb && !palette) throw new Error('Unsupported TIFF color layout')
}

const assertSafeDecodedLayout = (
  ifd: TiffIfd,
  fileBytes: number,
  limits: TiffPreviewLimits
): void => {
  const { width, height, components } = ifd
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_TIFF_DIMENSION ||
    height > MAX_TIFF_DIMENSION
  ) {
    throw new Error('TIFF page dimensions are too large to preview safely')
  }

  const pixels = width * height
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
    throw new Error('TIFF page is too large to preview safely')
  }

  assertSupportedColorLayout(ifd)
  const bytesPerSample = getBytesPerSample(ifd)
  const sampleBytes = pixels * components * bytesPerSample
  const rgbaBytes = pixels * 4
  // Compressed pages temporarily retain both the inflated strip and decoded sample array. The
  // fixed scratch reserve also covers the LZW dictionary's short-lived JavaScript arrays.
  const decompressorBytes =
    ifd.compression === 1 ? 0 : sampleBytes + TIFF_DECOMPRESSOR_SCRATCH_BYTES
  // Account for decoder samples plus transferred RGBA, ImageData, and the canvas surface.
  const estimatedBytes = fileBytes + sampleBytes + decompressorBytes + rgbaBytes * 3
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > limits.maxDecodedBytes) {
    throw new Error('TIFF page needs too much memory to preview safely')
  }
}

const convertToRgba = (ifd: TiffIfd): Uint8ClampedArray => {
  const rgba = new Uint8ClampedArray(ifd.size * 4)
  const hasAlpha = ifd.components === 2 || ifd.components === 4
  const colorComponentCount = ifd.components - (hasAlpha ? 1 : 0)
  const range = getSampleRange(
    ifd,
    Array.from({ length: colorComponentCount }, (_, index) => index)
  )
  const alphaRange = hasAlpha ? getSampleRange(ifd, [ifd.components - 1]) : range

  if ((ifd.type === 0 || ifd.type === 1) && (ifd.components === 1 || ifd.components === 2)) {
    for (let pixel = 0; pixel < ifd.size; pixel += 1) {
      const source = pixel * ifd.components
      const target = pixel * 4
      const value = sampleToByte(ifd.data[source], range)
      rgba[target] = value
      rgba[target + 1] = value
      rgba[target + 2] = value
      // tiff@7.1.3 applies WhiteIsZero inversion to the entire sample array, including
      // ExtraSamples. Photometric inversion does not apply to alpha, so undo it here.
      if (ifd.components === 2) {
        const alphaSample =
          ifd.type === 0 ? ifd.maxSampleValue - ifd.data[source + 1] : ifd.data[source + 1]
        rgba[target + 3] = sampleToByte(alphaSample, alphaRange)
      } else {
        rgba[target + 3] = 255
      }
    }
    return rgba
  }

  if (ifd.type === 3 && ifd.components === 1) {
    const palette = ifd.palette
    if (!palette) throw new Error('Unsupported TIFF color layout')

    for (let pixel = 0; pixel < ifd.size; pixel += 1) {
      const color = palette[ifd.data[pixel]]
      if (!color) throw new Error('Unsupported TIFF palette index')

      const target = pixel * 4
      const paletteRange = { minimum: 0, maximum: 65535 }
      rgba[target] = sampleToByte(color[0], paletteRange)
      rgba[target + 1] = sampleToByte(color[1], paletteRange)
      rgba[target + 2] = sampleToByte(color[2], paletteRange)
      rgba[target + 3] = 255
    }
    return rgba
  }

  if (ifd.type !== 2 || (ifd.components !== 3 && ifd.components !== 4)) {
    throw new Error('Unsupported TIFF color layout')
  }

  for (let pixel = 0; pixel < ifd.size; pixel += 1) {
    const source = pixel * ifd.components
    const target = pixel * 4
    rgba[target] = sampleToByte(ifd.data[source], range)
    rgba[target + 1] = sampleToByte(ifd.data[source + 1], range)
    rgba[target + 2] = sampleToByte(ifd.data[source + 2], range)
    rgba[target + 3] = ifd.components === 4 ? sampleToByte(ifd.data[source + 3], alphaRange) : 255
  }

  return rgba
}

const decodeTiffPage = (
  data: ArrayBuffer,
  pageIndex: number,
  limits: TiffPreviewLimits = DEFAULT_TIFF_PREVIEW_LIMITS
): DecodedTiffPage => {
  if (data.byteLength > limits.maxFileBytes) {
    throw new Error('TIFF file is too large to preview safely')
  }

  const { pageCount } = inspectTiffStructure(data)
  const [metadata] = decode(data, { pages: [pageIndex], ignoreImageData: true })

  if (!metadata) throw new RangeError(`TIFF page ${pageIndex + 1} is unavailable`)
  assertSafeDecodedLayout(metadata, data.byteLength, limits)
  assertTiffCompressionSafe(data, metadata)

  const [ifd] = decode(data, { pages: [pageIndex] })

  if (!ifd) throw new RangeError(`TIFF page ${pageIndex + 1} is unavailable`)

  return {
    width: ifd.width,
    height: ifd.height,
    pageIndex,
    pageCount,
    rgba: convertToRgba(ifd)
  }
}

const resizeDecodedTiffPage = (
  page: DecodedTiffPage,
  maxOutputDimension: number
): DecodedTiffPage => {
  if (!Number.isSafeInteger(maxOutputDimension) || maxOutputDimension <= 0) {
    throw new Error('Invalid TIFF output dimension')
  }
  if (Math.max(page.width, page.height) <= maxOutputDimension) return page

  const scale = maxOutputDimension / Math.max(page.width, page.height)
  const width = Math.max(1, Math.round(page.width * scale))
  const height = Math.max(1, Math.round(page.height * scale))
  const rgba = new Uint8ClampedArray(width * height * 4)

  for (let targetY = 0; targetY < height; targetY += 1) {
    const sourceY = Math.min(page.height - 1, Math.floor(((targetY + 0.5) * page.height) / height))
    for (let targetX = 0; targetX < width; targetX += 1) {
      const sourceX = Math.min(page.width - 1, Math.floor(((targetX + 0.5) * page.width) / width))
      const source = (sourceY * page.width + sourceX) * 4
      const target = (targetY * width + targetX) * 4
      rgba[target] = page.rgba[source]
      rgba[target + 1] = page.rgba[source + 1]
      rgba[target + 2] = page.rgba[source + 2]
      rgba[target + 3] = page.rgba[source + 3]
    }
  }

  return { ...page, width, height, rgba }
}

export { decodeTiffPage, resizeDecodedTiffPage }
