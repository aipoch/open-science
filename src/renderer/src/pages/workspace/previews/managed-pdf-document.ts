import type { ManagedPreviewResource } from '../../../../../shared/preview-resources'
import { pdfjsLib } from './pdfjs'

const PDF_RANGE_CHUNK_SIZE = 64 * 1024
const PDF_IPC_CHUNK_SIZE = 1024 * 1024

const readRangeInChunks = async (
  resourceId: string,
  begin: number,
  end: number,
  isAborted: () => boolean
): Promise<Uint8Array> => {
  const data = new Uint8Array(end - begin)

  // Split PDF.js ranges at the IPC limit without changing the range requested by PDF.js.
  for (let chunkBegin = begin; chunkBegin < end; chunkBegin += PDF_IPC_CHUNK_SIZE) {
    if (isAborted()) throw new Error('Managed PDF range read aborted.')

    const chunkEnd = Math.min(end, chunkBegin + PDF_IPC_CHUNK_SIZE)
    const range = await window.api.previewResources.readRange({
      resourceId,
      begin: chunkBegin,
      end: chunkEnd
    })

    if (isAborted()) throw new Error('Managed PDF range read aborted.')
    if (
      range.begin !== chunkBegin ||
      range.end !== chunkEnd ||
      range.data.byteLength !== chunkEnd - chunkBegin
    ) {
      throw new Error('Managed PDF range response did not match the requested chunk.')
    }
    data.set(range.data, chunkBegin - begin)
  }

  return data
}

type GetPdfDocument = (
  options: Parameters<typeof pdfjsLib.getDocument>[0]
) => ReturnType<typeof pdfjsLib.getDocument>

// Adapts PDF.js range requests to the managed, owner-scoped IPC resource.
class ManagedPdfRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  private aborted = false

  constructor(
    private readonly resourceId: string,
    length: number,
    private readonly onReadError: (error: unknown) => void
  ) {
    super(length, null, true)
  }

  override requestDataRange(begin: number, end: number): void {
    void readRangeInChunks(this.resourceId, begin, end, () => this.aborted)
      .then((data) => {
        if (!this.aborted) this.onDataRange(begin, data)
      })
      .catch((error: unknown) => {
        if (!this.aborted) this.onReadError(error)
      })
  }

  override abort(): void {
    this.aborted = true
  }
}

// Creates a PDF.js task that fetches only explicitly requested ranges from disk.
const createManagedPdfLoadingTask = (
  resource: ManagedPreviewResource,
  getDocument: GetPdfDocument = pdfjsLib.getDocument
): ReturnType<typeof pdfjsLib.getDocument> => {
  const loadingTaskRef: { current?: ReturnType<typeof pdfjsLib.getDocument> } = {}
  const range = new ManagedPdfRangeTransport(resource.id, resource.size, (error) => {
    console.error('Failed to read PDF range', error)
    void loadingTaskRef.current?.destroy()
  })

  const loadingTask = getDocument({
    length: resource.size,
    range,
    rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
    disableStream: true,
    disableAutoFetch: true
  })
  // Page and component cleanup can race, so make PDF.js destruction idempotent.
  const destroyLoadingTask = loadingTask.destroy.bind(loadingTask)
  let destroyPromise: ReturnType<typeof loadingTask.destroy> | undefined
  loadingTask.destroy = () => {
    destroyPromise ??= destroyLoadingTask()
    return destroyPromise
  }
  loadingTaskRef.current = loadingTask
  return loadingTask
}

export { createManagedPdfLoadingTask, PDF_IPC_CHUNK_SIZE, PDF_RANGE_CHUNK_SIZE }
