import type { DecodedTiffPage, TiffPreviewLimits } from './tiff-preview-types'
import type {
  TiffDecodeWorkerRequest,
  TiffDecodeWorkerResponse
} from './tiff-preview-worker-protocol'

const DEFAULT_TIFF_DECODE_TIMEOUT_MS = 15_000

type TiffWorker = Pick<
  Worker,
  'addEventListener' | 'postMessage' | 'removeEventListener' | 'terminate'
>

type TiffDecodeSessionOptions = {
  timeoutMs?: number
  createWorker?: () => TiffWorker
  limits?: TiffPreviewLimits
  maxOutputDimension?: number
}

type PendingDecode = {
  resolve: (page: DecodedTiffPage) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
  settled: boolean
}

type TiffDecodeSession = {
  decodePage: (pageIndex: number, signal?: AbortSignal) => Promise<DecodedTiffPage>
  dispose: () => void
  isDisposed: () => boolean
}

const createAbortError = (): Error => new DOMException('TIFF decoding was cancelled', 'AbortError')

const createDefaultWorker = (): Worker =>
  new Worker(new URL('./tiff-preview-worker.ts', import.meta.url), { type: 'module' })

const createTiffDecodeSession = (
  data: ArrayBuffer,
  options: TiffDecodeSessionOptions = {}
): TiffDecodeSession => {
  const worker = (options.createWorker ?? createDefaultWorker)()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIFF_DECODE_TIMEOUT_MS
  const pending = new Map<number, PendingDecode>()
  let nextRequestId = 0
  let initialData: ArrayBuffer | undefined = data
  let disposed = false

  const removeAbortListener = (decode: PendingDecode): void => {
    if (decode.signal && decode.onAbort) {
      decode.signal.removeEventListener('abort', decode.onAbort)
    }
  }

  const failSession = (error: Error): void => {
    if (disposed) return
    disposed = true
    worker.removeEventListener('message', onMessage as EventListener)
    worker.removeEventListener('error', onError)
    worker.terminate()
    for (const decode of pending.values()) {
      clearTimeout(decode.timeout)
      removeAbortListener(decode)
      if (!decode.settled) decode.reject(error)
    }
    pending.clear()
    initialData = undefined
  }

  const onMessage = (event: MessageEvent<TiffDecodeWorkerResponse>): void => {
    const response = event.data
    const decode = pending.get(response.requestId)
    if (!decode) return

    pending.delete(response.requestId)
    clearTimeout(decode.timeout)
    removeAbortListener(decode)
    if (decode.settled) return
    decode.settled = true

    if (response.type === 'decoded') decode.resolve(response.page)
    else decode.reject(new Error(response.message))
  }

  const onError = (): void => failSession(new Error('TIFF decoder worker failed'))
  worker.addEventListener('message', onMessage as EventListener)
  worker.addEventListener('error', onError)

  const decodePage = (pageIndex: number, signal?: AbortSignal): Promise<DecodedTiffPage> => {
    if (disposed) return Promise.reject(new Error('TIFF decoder is unavailable'))
    if (signal?.aborted) return Promise.reject(createAbortError())

    const requestId = ++nextRequestId
    return new Promise<DecodedTiffPage>((resolve, reject) => {
      const timeout = setTimeout(() => failSession(new Error('TIFF decoding timed out')), timeoutMs)
      const decode: PendingDecode = { resolve, reject, timeout, signal, settled: false }
      if (signal) {
        decode.onAbort = () => failSession(createAbortError())
        signal.addEventListener('abort', decode.onAbort, { once: true })
      }
      pending.set(requestId, decode)

      const request: TiffDecodeWorkerRequest = {
        type: 'decode',
        requestId,
        pageIndex,
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.maxOutputDimension ? { maxOutputDimension: options.maxOutputDimension } : {}),
        ...(initialData ? { data: initialData } : {})
      }

      try {
        if (initialData) {
          const transferredData = initialData
          initialData = undefined
          worker.postMessage(request, [transferredData])
        } else {
          worker.postMessage(request)
        }
      } catch (error) {
        failSession(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const dispose = (): void => failSession(createAbortError())
  const isDisposed = (): boolean => disposed

  return { decodePage, dispose, isDisposed }
}

export { createTiffDecodeSession, DEFAULT_TIFF_DECODE_TIMEOUT_MS }
export type { TiffDecodeSession, TiffDecodeSessionOptions, TiffWorker }
