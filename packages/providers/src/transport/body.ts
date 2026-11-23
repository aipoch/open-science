import { redactSensitiveText } from '@aipoch/diagnostics'

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

// Match only bounded, known wording at the start of a provider message. Anything after it
// can be an echoed prompt, credential, account identifier or proprietary gateway response.
const publicProviderPhrases = [
  /^(?:unsupported|invalid) parameter:\s*['"`]?(?:temperature|top_p|max_tokens|max_completion_tokens|max_output_tokens|response_format|reasoning_effort|tool_choice)\b['"`]?/i,
  /^(?:this model['’]s )?maximum context length is \d{1,9} tokens\b(?:[.,]?\s+(?:however,?\s+)?you requested \d{1,9} tokens\b)?/i,
  /^(?:maximum call stack size exceeded|rate limit (?:reached|exceeded)|too many requests|insufficient quota|you exceeded your current quota|incorrect api key provided|invalid api key|(?:the )?model is overloaded)\b/i
]

export function providerErrorExcerpt(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined
  const prefix = message.slice(0, 300).trimStart()
  for (const phrase of publicProviderPhrases) {
    const match = phrase.exec(prefix)
    if (match) return match[0].replace(/\s+/g, ' ')
  }
  return undefined
}

/** Keep provider/Agent wording readable without forwarding credentials or an unbounded payload. */
export function providerErrorDetails(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  for (const secret of secrets) {
    if (secret) {
      for (const value of [
        secret,
        JSON.stringify(secret).slice(1, -1),
        encodeURIComponent(secret)
      ]) {
        text = text.replaceAll(value, '[REDACTED]')
      }
    }
  }
  const displayText = text
    .replace(/^\[provider-text-generation:[a-z-]+\]\s*/, '')
    .replace(/\[provider-failure:[a-z-]+:\d+\]\s*/g, '')
  return redactSensitiveText(displayText).slice(0, 4096)
}

export {
  DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
  DEFAULT_MAX_PROVIDER_SSE_EVENT_BYTES,
  DEFAULT_MAX_PROVIDER_SSE_LINE_BYTES,
  ResponseBodyLimitError,
  consumeBoundedResponseBody,
  readBoundedResponseBytes,
  readBoundedResponseText
}
