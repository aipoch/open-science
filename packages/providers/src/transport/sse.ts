import {
  iterateBoundedResponseBody,
  ResponseBodyLimitError,
  DEFAULT_MAX_PROVIDER_SSE_EVENT_BYTES,
  DEFAULT_MAX_PROVIDER_SSE_LINE_BYTES
} from './body'

/** SSE framing only: data contents and terminal markers belong to the protocol decoder. */
export async function* readSseRecords(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffered = ''
  const validate = (record: string): void => {
    if (Buffer.byteLength(record) > DEFAULT_MAX_PROVIDER_SSE_EVENT_BYTES)
      throw new ResponseBodyLimitError('Provider SSE event', DEFAULT_MAX_PROVIDER_SSE_EVENT_BYTES)
    if (
      record
        .split(/\r?\n/)
        .some((line) => Buffer.byteLength(line) > DEFAULT_MAX_PROVIDER_SSE_LINE_BYTES)
    )
      throw new ResponseBodyLimitError('Provider SSE line', DEFAULT_MAX_PROVIDER_SSE_LINE_BYTES)
  }
  for await (const chunk of iterateBoundedResponseBody(
    response,
    maxBytes,
    'Chat Completions upstream SSE response',
    signal
  )) {
    buffered += decoder.decode(chunk, { stream: true })
    const records = buffered.split(/\r?\n\r?\n/)
    buffered = records.pop() ?? ''
    for (const record of records) {
      validate(record)
      yield record
    }
    validate(buffered)
  }
  buffered += decoder.decode()
  if (buffered.trim()) {
    validate(buffered)
    yield buffered
  }
}
