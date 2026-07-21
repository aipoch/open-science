// Wire protocol shared between the Node kernel driver and the Python/R exec-loop scripts.

export type KernelLoopFigure = { mime: string; path: string }

export type KernelLoopResponse = {
  reqId: string
  stdout: string
  stderr: string
  error: string | null
  // 1-based source line of the failing statement when the loop can attribute one (R); null otherwise.
  errorLine: number | null
  result: string | null
  cwd: string
  figures: KernelLoopFigure[]
}

// Env var the driver sets so a loop script knows where to write captured figure files.
export const KERNEL_FIGURES_DIR_ENV = 'OPEN_SCIENCE_KERNEL_FIGURES_DIR'

// Parses one loop stdout line (snake_case wire fields -> camelCase). Returns null when the line is
// not valid JSON or not an object, since loop stdout can contain unrelated noise the driver ignores.
// Missing/invalid fields fall back to safe defaults rather than throwing.
export function parseLoopResponse(line: string): KernelLoopResponse | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const obj = parsed as Record<string, unknown>
  const figures: KernelLoopFigure[] = Array.isArray(obj.figures)
    ? obj.figures
        .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
        .map((f) => ({ mime: String(f.mime), path: String(f.path) }))
    : []

  return {
    reqId: typeof obj.req_id === 'string' ? obj.req_id : '',
    stdout: typeof obj.stdout === 'string' ? obj.stdout : '',
    stderr: typeof obj.stderr === 'string' ? obj.stderr : '',
    error: typeof obj.error === 'string' ? obj.error : null,
    errorLine:
      typeof obj.error_line === 'number' && Number.isFinite(obj.error_line) ? obj.error_line : null,
    result: typeof obj.result === 'string' ? obj.result : null,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : '',
    figures
  }
}

// One JSON line + newline for the Python loop's stdin protocol; key order is stable so the wire
// format is deterministic across runs.
export function framePythonRequest(reqId: string, code: string): string {
  return `${JSON.stringify({ req_id: reqId, code })}\n`
}

// R length-prefixed frame: a "<reqId> <codeByteLength>\n" header followed by the exact UTF-8 code
// bytes. The byte length (not JS string length) lets the R side read a precise number of bytes for
// multibyte code.
export function frameRRequest(reqId: string, code: string): Buffer {
  const codeBuf = Buffer.from(code, 'utf8')
  const header = Buffer.from(`${reqId} ${codeBuf.byteLength}\n`, 'utf8')
  return Buffer.concat([header, codeBuf])
}
