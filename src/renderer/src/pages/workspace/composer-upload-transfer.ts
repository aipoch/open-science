import {
  MAX_UPLOAD_CHUNK_BYTES,
  type AppendUploadTransferRequest,
  type BeginUploadTransferRequest,
  type UploadTransferProgress,
  type UploadTransferRequest,
  type UploadTransferStatus,
  type UploadedAttachment
} from '../../../../shared/uploads'

// Narrow adapter consumed by the composer. Desktop preload adds stageLocalFile; Web intentionally
// omits it and therefore uses the same chunk methods through RPC.
export type UploadStagingApi = {
  stageLocalFile?: (
    file: File,
    request: BeginUploadTransferRequest
  ) => Promise<UploadedAttachment | null>
  beginTransfer: (request: BeginUploadTransferRequest) => Promise<UploadTransferStatus>
  appendTransfer: (request: AppendUploadTransferRequest) => Promise<UploadTransferStatus>
  getTransferStatus: (request: UploadTransferRequest) => Promise<UploadTransferStatus | null>
  finishTransfer: (request: UploadTransferRequest) => Promise<UploadedAttachment>
  abortTransfer: (request: UploadTransferRequest) => Promise<void>
  deleteUpload: (request: { path: string }) => Promise<void>
  onTransferProgress?: (listener: (progress: UploadTransferProgress) => void) => () => void
}

type StageComposerFileOptions = {
  transferId: string
  name: string
  signal?: AbortSignal
  onProgress?: (progress: UploadTransferProgress) => void
  // Injectable for fast tests; production always uses MAX_UPLOAD_CHUNK_BYTES.
  chunkBytes?: number
}

export type ComposerUploadTransfer = UploadTransferProgress & {
  mimeType?: string
  status: 'queued' | 'uploading' | 'cancelling' | 'error'
  error?: string
}

const abortError = (): DOMException => new DOMException('Upload cancelled.', 'AbortError')

const assertNotAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError()
}

const appendChunkWithRecovery = async (
  api: UploadStagingApi,
  request: AppendUploadTransferRequest,
  signal?: AbortSignal
): Promise<UploadTransferStatus> => {
  let lastError: unknown

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertNotAborted(signal)
    try {
      return await api.appendTransfer(request)
    } catch (error) {
      lastError = error
      assertNotAborted(signal)
      const status = await api.getTransferStatus({ transferId: request.transferId })

      // A lost response may hide a successful append. Resume from the authoritative main-process
      // offset instead of sending the same bytes twice.
      if (status && status.receivedBytes === request.offset + request.chunk.byteLength)
        return status
      if (!status || status.receivedBytes !== request.offset) throw error
    }
  }

  throw lastError
}

// Stages one File through the desktop path adapter when possible, otherwise through bounded chunks.
// The resulting attachment is always a managed path; no full-file base64 representation is created.
export const stageComposerFile = async (
  file: File,
  api: UploadStagingApi,
  options: StageComposerFileOptions
): Promise<UploadedAttachment> => {
  const request: BeginUploadTransferRequest = {
    transferId: options.transferId,
    name: options.name,
    mimeType: file.type || undefined,
    size: file.size
  }
  const chunkBytes = options.chunkBytes ?? MAX_UPLOAD_CHUNK_BYTES

  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > MAX_UPLOAD_CHUNK_BYTES) {
    throw new Error('Invalid upload chunk size.')
  }

  options.onProgress?.({
    transferId: request.transferId,
    name: request.name,
    receivedBytes: 0,
    totalBytes: request.size
  })

  const removeProgressListener =
    api.onTransferProgress?.((progress) => {
      if (progress.transferId === request.transferId) options.onProgress?.(progress)
    }) ?? (() => undefined)

  try {
    assertNotAborted(options.signal)

    if (api.stageLocalFile) {
      const localAttachment = await api.stageLocalFile(file, request)
      if (localAttachment) {
        if (options.signal?.aborted) {
          await api.deleteUpload({ path: localAttachment.path }).catch(() => undefined)
          throw abortError()
        }
        return localAttachment
      }
    }

    let status = await api.beginTransfer(request)
    if (status.receivedBytes > 0) options.onProgress?.(status)

    while (status.receivedBytes < request.size) {
      assertNotAborted(options.signal)
      const end = Math.min(status.receivedBytes + chunkBytes, request.size)
      const chunk = new Uint8Array(await file.slice(status.receivedBytes, end).arrayBuffer())
      assertNotAborted(options.signal)
      status = await appendChunkWithRecovery(
        api,
        { transferId: request.transferId, offset: status.receivedBytes, chunk },
        options.signal
      )
      options.onProgress?.(status)
    }

    assertNotAborted(options.signal)
    const attachment = await api.finishTransfer({ transferId: request.transferId })
    if (options.signal?.aborted) {
      await api.deleteUpload({ path: attachment.path }).catch(() => undefined)
      throw abortError()
    }
    return attachment
  } catch (error) {
    await api.abortTransfer({ transferId: request.transferId }).catch(() => undefined)
    throw error
  } finally {
    removeProgressListener()
  }
}
