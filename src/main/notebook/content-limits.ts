import type { NotebookOutput } from '../../shared/notebook'

const MIB = 1024 * 1024

export const NOTEBOOK_CODE_LIMIT_BYTES = 1 * MIB
export const NOTEBOOK_TEXT_LIMIT_BYTES = 2 * MIB
export const NOTEBOOK_PROTOCOL_LINE_LIMIT_BYTES = 16 * MIB
export const NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES = 16 * 1024
export const NOTEBOOK_FIGURE_LIMIT_BYTES = Math.floor(3.5 * MIB)
export const NOTEBOOK_FIGURE_COUNT_LIMIT = 12
export const NOTEBOOK_FIGURE_TOTAL_LIMIT_BYTES = 8 * MIB
export const NOTEBOOK_RENDERER_RUN_LIMIT = 100
export const NOTEBOOK_NAMESPACE_VARIABLE_LIMIT = 500
export const NOTEBOOK_NAMESPACE_PREVIEW_LIMIT_BYTES = 512
export const NOTEBOOK_NAMESPACE_RESPONSE_LIMIT_BYTES = 256 * 1024

export const NOTEBOOK_TEXT_LIMIT_ENV = 'OPEN_SCIENCE_NOTEBOOK_TEXT_LIMIT_BYTES'
export const NOTEBOOK_FIGURE_LIMIT_ENV = 'OPEN_SCIENCE_NOTEBOOK_FIGURE_LIMIT_BYTES'
export const NOTEBOOK_FIGURE_COUNT_LIMIT_ENV = 'OPEN_SCIENCE_NOTEBOOK_FIGURE_COUNT_LIMIT'
export const NOTEBOOK_FIGURE_TOTAL_LIMIT_ENV = 'OPEN_SCIENCE_NOTEBOOK_FIGURE_TOTAL_LIMIT_BYTES'
export const NOTEBOOK_NAMESPACE_VARIABLE_LIMIT_ENV =
  'OPEN_SCIENCE_NOTEBOOK_NAMESPACE_VARIABLE_LIMIT'
export const NOTEBOOK_NAMESPACE_PREVIEW_LIMIT_ENV =
  'OPEN_SCIENCE_NOTEBOOK_NAMESPACE_PREVIEW_LIMIT_BYTES'
export const NOTEBOOK_NAMESPACE_RESPONSE_LIMIT_ENV =
  'OPEN_SCIENCE_NOTEBOOK_NAMESPACE_RESPONSE_LIMIT_BYTES'

type LimitedText = { text: string; truncated: boolean }

// Takes a UTF-8 prefix without leaving an invalid partial code point at the boundary.
export const limitUtf8 = (value: string, limitBytes: number): LimitedText => {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.byteLength <= limitBytes) return { text: value, truncated: false }
  if (limitBytes <= 0) return { text: '', truncated: value.length > 0 }

  let end = Math.min(limitBytes, encoded.byteLength)
  while (end > 0 && end < encoded.byteLength && (encoded[end] & 0xc0) === 0x80) end -= 1
  return { text: encoded.subarray(0, end).toString('utf8'), truncated: true }
}

const assertNotebookCodeBytesWithinLimit = (bytes: number): void => {
  if (bytes > NOTEBOOK_CODE_LIMIT_BYTES) {
    throw new Error(
      `Notebook code exceeds the ${NOTEBOOK_CODE_LIMIT_BYTES}-byte limit (${bytes} bytes received).`
    )
  }
}

export const assertNotebookCodeWithinLimit = (code: string): void => {
  assertNotebookCodeBytesWithinLimit(Buffer.byteLength(code, 'utf8'))
}

// Checks a streamed append before concatenation so an oversized delta cannot allocate a second,
// equally oversized combined string merely to be rejected.
export const assertNotebookCodeAppendWithinLimit = (code: string, delta: string): void => {
  assertNotebookCodeBytesWithinLimit(
    Buffer.byteLength(code, 'utf8') + Buffer.byteLength(delta, 'utf8')
  )
}

type NotebookTerminalContent = {
  stdout: string
  stderr: string
  traceback: string
  outputs: NotebookOutput[]
  truncated?: boolean
}

// Final defensive boundary before a run is persisted. Producer loops also receive the same budgets,
// but this keeps old/custom loop scripts and every executor adapter from bypassing the durable cap.
export const limitNotebookTerminalContent = <T extends NotebookTerminalContent>(
  value: T
): T & { truncated?: boolean } => {
  let remainingTextBytes = NOTEBOOK_TEXT_LIMIT_BYTES
  let truncated = value.truncated === true

  const takeText = (text: string): string => {
    const limited = limitUtf8(text, remainingTextBytes)
    remainingTextBytes -= Buffer.byteLength(limited.text, 'utf8')
    truncated ||= limited.truncated
    return limited.text
  }

  const stdout = takeText(value.stdout)
  const stderr = takeText(value.stderr)
  const traceback = takeText(value.traceback)
  let stdoutStreamUsed = false
  let stderrStreamUsed = false
  let errorUsed = false
  let figureCount = 0
  let figureBytes = 0

  const outputs: NotebookOutput[] = value.outputs.map((output) => {
    if (output.type === 'stream') {
      if (output.name === 'stdout' && !stdoutStreamUsed) {
        stdoutStreamUsed = true
        return { ...output, text: stdout }
      }
      if (output.name === 'stderr' && !stderrStreamUsed) {
        stderrStreamUsed = true
        return { ...output, text: stderr }
      }
      return { ...output, text: takeText(output.text) }
    }
    if (output.type === 'error') {
      if (!errorUsed) {
        errorUsed = true
        return { ...output, traceback }
      }
      return { ...output, traceback: takeText(output.traceback) }
    }
    if (output.type === 'text') return { ...output, text: takeText(output.text) }
    if (output.type === 'json') {
      let serialized: string
      try {
        serialized = JSON.stringify(output.data) ?? String(output.data)
      } catch {
        serialized = String(output.data)
      }
      const limited = takeText(serialized)
      return limited === serialized ? output : { ...output, data: limited }
    }

    const data: Record<string, string> = {}
    for (const [mime, payload] of Object.entries(output.data)) {
      if (!mime.startsWith('image/')) {
        data[mime] = takeText(payload)
        continue
      }
      const bytes = Buffer.byteLength(payload, 'base64')
      if (
        figureCount >= NOTEBOOK_FIGURE_COUNT_LIMIT ||
        bytes > NOTEBOOK_FIGURE_LIMIT_BYTES ||
        figureBytes + bytes > NOTEBOOK_FIGURE_TOTAL_LIMIT_BYTES
      ) {
        truncated = true
        continue
      }
      figureCount += 1
      figureBytes += bytes
      data[mime] = payload
    }
    return { ...output, data }
  })

  return { ...value, stdout, stderr, traceback, outputs, ...(truncated ? { truncated: true } : {}) }
}
