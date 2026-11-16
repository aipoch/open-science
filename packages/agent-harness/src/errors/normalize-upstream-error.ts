export type AdapterErrorPhase =
  | 'response'
  | 'stream'
  | 'event-json'
  | 'provider'
  | 'choice'
  | 'usage'
  | 'tool-delta'
  | 'missing-done'
  | 'missing-finish'
  | 'tool-arguments'

/** 只携带有限的上游字段，不保存原始响应、请求头或请求体。 */
export type UpstreamErrorDiagnostics = Readonly<{
  phase?: AdapterErrorPhase
  upstreamCode?: string
  safeMessage?: string
  requestId?: string
}>

const MAX_ERROR_BODY_BYTES = 16_384
const ERROR_BODY_TIMEOUT_MS = 2_000
const MAX_ERROR_MESSAGE_LENGTH = 300
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id', 'openai-request-id'] as const

const textField = (value: unknown, max = MAX_ERROR_MESSAGE_LENGTH): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text || text.startsWith('<')) return undefined
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** 从响应头白名单读取请求标识，适用于 HTTP 错误及 SSE 解析错误。 */
export const responseErrorDiagnostics = (response: Response): UpstreamErrorDiagnostics => {
  const requestId = REQUEST_ID_HEADERS.map((name) =>
    textField(response.headers.get(name), 200)
  ).find(Boolean)
  return requestId ? { requestId } : {}
}

/** 从 JSON 错误或 SSE error 事件提取字段白名单，忽略其他业务数据。 */
export const normalizeProviderError = (value: unknown): UpstreamErrorDiagnostics => {
  const root = object(value)
  if (!root) return {}
  const error = object(root.error) ?? root
  const upstreamCode = textField(error.code, 120) ?? textField(error.type, 120)
  const safeMessage = textField(error.message) ?? textField(root.message)
  const requestId = textField(root.request_id, 200) ?? textField(error.request_id, 200)
  return {
    ...(upstreamCode ? { upstreamCode } : {}),
    ...(safeMessage ? { safeMessage } : {}),
    ...(requestId ? { requestId } : {})
  }
}

/**
 * 有界读取错误正文，并在超时、取消或超限后释放流；读取失败不覆盖 HTTP 状态。
 *
 * Args:
 *   response: 上游 HTTP 响应。
 *   signal: 当前模型调用的取消信号。
 *
 * Returns:
 *   字段白名单中的错误消息、错误码和请求标识。
 */
export const normalizeUpstreamError = async (
  response: Response,
  signal: AbortSignal
): Promise<UpstreamErrorDiagnostics> => {
  signal.throwIfAborted()
  const headers = responseErrorDiagnostics(response)
  const reader = response.body?.getReader()
  if (!reader) return headers
  let body = ''
  let size = 0
  let complete = false
  const decoder = new TextDecoder()
  // cancel() 可能受底层 stream 的实现影响而不结束，因此不等待其完成。
  const stop = AbortSignal.any([signal, AbortSignal.timeout(ERROR_BODY_TIMEOUT_MS)])
  let stopped!: () => void
  const cancelled = new Promise<undefined>((resolve) => {
    stopped = () => resolve(undefined)
  })
  const cancel = (): void => {
    stopped()
    void reader.cancel().catch(() => undefined)
  }
  stop.addEventListener('abort', cancel, { once: true })
  try {
    while (!stop.aborted) {
      const chunk = await Promise.race([reader.read(), cancelled])
      if (!chunk) break
      if (chunk.done) {
        complete = true
        body += decoder.decode()
        break
      }
      const remaining = MAX_ERROR_BODY_BYTES - size
      const part = chunk.value.subarray(0, remaining)
      size += part.byteLength
      body += decoder.decode(part, { stream: true })
      // 恰好达到上限仍需确认 EOF；只有多出字节才判为截断，额外字节不保留。
      if (chunk.value.byteLength > remaining) break
    }
  } catch {
    // 上游中断时仍保留响应头的 request-id；不把异常或请求信息写进诊断。
  } finally {
    stop.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
  signal.throwIfAborted()
  const text = body.trim()
  if (response.headers.get('content-type')?.toLowerCase().includes('html') || text.startsWith('<'))
    return headers
  const isJson =
    response.headers.get('content-type')?.toLowerCase().includes('json') || /^[{[]/.test(text)
  if (isJson) {
    if (!complete) return headers
    try {
      return { ...normalizeProviderError(JSON.parse(text)), ...headers }
    } catch {
      // 损坏或截断的 JSON 不降级为原文，避免把整个响应当作错误消息。
      return headers
    }
  }
  const safeMessage = textField(text)
  return { ...(safeMessage ? { safeMessage } : {}), ...headers }
}
