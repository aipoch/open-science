class ResponseBodyLimitError extends Error {
  readonly name = 'ResponseBodyLimitError'

  constructor(
    readonly label: string,
    readonly maxBytes: number
  ) {
    super(`${label} exceeded ${maxBytes} bytes.`)
  }
}

const readBoundedResponseText = async (
  response: Response,
  maxBytes: number,
  label: string
): Promise<string> => {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ResponseBodyLimitError(label, maxBytes)
  }

  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let observedBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      observedBytes += value.byteLength
      if (observedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ResponseBodyLimitError(label, maxBytes)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks, observedBytes).toString('utf8')
}

export { ResponseBodyLimitError, readBoundedResponseText }
