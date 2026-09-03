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

const consumeBoundedResponseBody = async (
  response: Response,
  maxBytes: number,
  label: string,
  consume: (chunk: Uint8Array) => void
): Promise<void> => {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ResponseBodyLimitError(label, maxBytes)
  }

  if (!response.body) return

  const reader = response.body.getReader()
  let observedBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      observedBytes += value.byteLength
      if (observedBytes > maxBytes) {
        throw new ResponseBodyLimitError(label, maxBytes)
      }
      consume(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

const readBoundedResponseBytes = async (
  response: Response,
  maxBytes: number,
  label: string,
  onActivity?: () => void
): Promise<Buffer> => {
  const chunks: Buffer[] = []
  let observedBytes = 0
  await consumeBoundedResponseBody(response, maxBytes, label, (chunk) => {
    onActivity?.()
    observedBytes += chunk.byteLength
    chunks.push(Buffer.from(chunk))
  })
  return Buffer.concat(chunks, observedBytes)
}

const readBoundedResponseText = async (
  response: Response,
  maxBytes: number,
  label: string,
  onActivity?: () => void
): Promise<string> =>
  new TextDecoder().decode(await readBoundedResponseBytes(response, maxBytes, label, onActivity))

export {
  DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
  DEFAULT_MAX_PROVIDER_SSE_EVENT_BYTES,
  DEFAULT_MAX_PROVIDER_SSE_LINE_BYTES,
  ResponseBodyLimitError,
  consumeBoundedResponseBody,
  readBoundedResponseBytes,
  readBoundedResponseText
}
