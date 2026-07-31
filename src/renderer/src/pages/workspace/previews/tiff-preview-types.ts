type DecodedTiffPage = {
  width: number
  height: number
  pageIndex: number
  pageCount: number
  rgba: Uint8ClampedArray
}

type TiffPreviewLimits = {
  maxFileBytes: number
  maxPixels: number
  maxDecodedBytes: number
}

const DEFAULT_TIFF_PREVIEW_LIMITS: TiffPreviewLimits = {
  maxFileBytes: 40 * 1024 * 1024,
  maxPixels: 25_000_000,
  maxDecodedBytes: 256 * 1024 * 1024
}

const TIFF_THUMBNAIL_LIMITS: TiffPreviewLimits = {
  maxFileBytes: 20 * 1024 * 1024,
  maxPixels: 4_000_000,
  maxDecodedBytes: 128 * 1024 * 1024
}

const TIFF_THUMBNAIL_MAX_DIMENSION = 512

export { DEFAULT_TIFF_PREVIEW_LIMITS, TIFF_THUMBNAIL_LIMITS, TIFF_THUMBNAIL_MAX_DIMENSION }
export type { DecodedTiffPage, TiffPreviewLimits }
