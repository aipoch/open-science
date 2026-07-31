import type { DecodedTiffPage, TiffPreviewLimits } from './tiff-preview-types'

type TiffDecodeWorkerRequest = {
  type: 'decode'
  requestId: number
  pageIndex: number
  data?: ArrayBuffer
  limits?: TiffPreviewLimits
  maxOutputDimension?: number
}

type TiffDecodeWorkerResponse =
  | { type: 'decoded'; requestId: number; page: DecodedTiffPage }
  | { type: 'error'; requestId: number; message: string }

export type { TiffDecodeWorkerRequest, TiffDecodeWorkerResponse }
