import { decodeTiffPage, resizeDecodedTiffPage } from './tiff-preview'
import type {
  TiffDecodeWorkerRequest,
  TiffDecodeWorkerResponse
} from './tiff-preview-worker-protocol'

let tiffData: ArrayBuffer | undefined

self.addEventListener('message', (event: MessageEvent<TiffDecodeWorkerRequest>) => {
  const request = event.data
  if (request.type !== 'decode') return
  if (request.data) tiffData = request.data

  try {
    if (!tiffData) throw new Error('TIFF worker has no file data')
    const decodedPage = decodeTiffPage(tiffData, request.pageIndex, request.limits)
    const page = request.maxOutputDimension
      ? resizeDecodedTiffPage(decodedPage, request.maxOutputDimension)
      : decodedPage
    const response: TiffDecodeWorkerResponse = {
      type: 'decoded',
      requestId: request.requestId,
      page
    }
    self.postMessage(response, { transfer: [page.rgba.buffer] })
  } catch (error) {
    const response: TiffDecodeWorkerResponse = {
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
})
