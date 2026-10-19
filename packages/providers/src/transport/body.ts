class ResponseBodyLimitError extends Error {
  readonly name = 'ResponseBodyLimitError'

  constructor(
    readonly label: string,
    readonly maxBytes: number
  ) {
    super(`${label} exceeded ${maxBytes} bytes.`)
  }
}

const DEFAULT_MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_PROVIDER_SSE_LINE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_PROVIDER_SSE_EVENT_BYTES = 8 * 1024 * 1024

export async function* iterateBoundedResponseBody(
  response: Response,
  maxBytes: number,
  label: string,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ResponseBodyLimitError(label, maxBytes)
  }
  if (!response.body) return
  const reader = response.body.getReader()
  const cancel = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  let observedBytes = 0
  let finished = false
  try {
    signal?.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) {
        finished = true
        return
      }
      observedBytes += value.byteLength
      if (observedBytes > maxBytes) throw new ResponseBodyLimitError(label, maxBytes)
      yield value
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const consumeBoundedResponseBody = async (
  response: Response,
  maxBytes: number,
  label: string,
  consume: (chunk: Uint8Array) => void,
  signal?: AbortSignal
): Promise<void> => {
  for await (const chunk of iterateBoundedResponseBody(response, maxBytes, label, signal))
    consume(chunk)
}

const readBoundedResponseBytes = async (
  response: Response,
  maxBytes: number,
  label: string,
  onActivity?: () => void,
  signal?: AbortSignal
): Promise<Buffer> => {
  const chunks: Buffer[] = []
  let observedBytes = 0
  await consumeBoundedResponseBody(
    response,
    maxBytes,
    label,
    (chunk) => {
      onActivity?.()
      observedBytes += chunk.byteLength
      chunks.push(Buffer.from(chunk))
    },
    signal
  )
  return Buffer.concat(chunks, observedBytes)
}

const readBoundedResponseText = async (
  response: Response,
  maxBytes: number,
  label: string,
  onActivity?: () => void,
  signal?: AbortSignal
): Promise<string> =>
  new TextDecoder().decode(
    await readBoundedResponseBytes(response, maxBytes, label, onActivity, signal)
  )

export {
  DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
  DEFAULT_MAX_PROVIDER_SSE_EVENT_BYTES,
  DEFAULT_MAX_PROVIDER_SSE_LINE_BYTES,
  ResponseBodyLimitError,
  consumeBoundedResponseBody,
  readBoundedResponseBytes,
  readBoundedResponseText
}
