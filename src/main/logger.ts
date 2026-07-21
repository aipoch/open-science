import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

// Lightweight structured file logger for the main process. Kept free of Electron imports so it stays
// unit-testable and usable from the MCP-server entry modes; the caller resolves the log directory
// (e.g. Electron's `app.getPath('logs')`) and passes it to `initLogger`. Every record is one JSON line
// so logs are greppable and machine-parseable when troubleshooting a packaged build.
//
// Logs self-clean: each file is capped at `maxBytes`; on overflow the file rotates (main.log ->
// main.1.log -> ...) and the oldest beyond `maxFiles` is deleted. Total on-disk size is therefore
// bounded (~maxBytes * maxFiles) no matter how heavily the app is used — no manual cleanup needed.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export type LoggerConfig = {
  logDir: string
  fileName: string
  minLevel: LogLevel
  mirrorToConsole: boolean
  // Max bytes per file before it rotates.
  maxBytes: number
  // Total files kept (the live file plus rotated backups). Older ones are deleted automatically.
  maxFiles: number
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MB per file
const DEFAULT_MAX_FILES = 3 // ~15 MB total ceiling

let config: LoggerConfig | undefined
// Serializes appends (and rotation) so concurrent log calls cannot interleave partial lines.
let writeChain: Promise<void> = Promise.resolve()
// Running size of the live file; undefined until seeded from disk on the first write after init.
let currentBytes: number | undefined

// Turns arbitrary log payloads into JSON-safe values, unwrapping Errors (whose fields are non-enumerable)
// so a stack trace actually lands in the log instead of `{}`.
const toSerializable = (value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }

  return value
}

// Own-property keys carried by common runtime errors that a bare message+stack capture would drop:
// JSON-RPC RequestErrors attach code + data (the provider/agent's real reason lives in data), and Node
// system errors attach errno/syscall/path/code. Enumerated explicitly because they are non-enumerable
// or inconsistently present, so a spread wouldn't reliably pick them up.
const ERROR_DETAIL_KEYS = ['name', 'code', 'data', 'errno', 'syscall', 'path'] as const

// Marker substituted for a value that points back to one of its own ancestors, so the sanitized output
// is always acyclic (and therefore always JSON-serializable).
const CIRCULAR_MARKER = '[circular]'
// Belt-and-suspenders bound on recursion depth: a pathological (non-cyclic but enormous) structure or a
// hostile object can't blow the stack or spin unbounded before the ancestor set would catch a true cycle.
const MAX_SANITIZE_DEPTH = 12

// Reads own-property keys defensively — an exotic Proxy can throw from its ownKeys trap.
const safeKeys = (value: object): string[] => {
  try {
    return Object.keys(value)
  } catch {
    return []
  }
}

// Recursively converts any value into a JSON-safe, acyclic structure. `seen` holds the *ancestor path*
// only (entries are removed on the way back up), so a value referenced twice in sibling positions is
// kept both times — only a real back-reference to an ancestor becomes the marker. Error instances are
// unwrapped at every depth (their fields are non-enumerable, so a nested Error would otherwise serialize
// to `{}`); bigint/function/symbol are stringified since JSON.stringify cannot represent them. Every
// property read is guarded so a throwing getter or a hostile Proxy degrades one field to a marker rather
// than aborting the whole record.
const toLogSafe = (value: unknown, seen: Set<object>, depth: number): unknown => {
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (typeof value === 'symbol') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) {
    // An invalid Date throws from toISOString(); guard so it can't take the whole log line down.
    const time = value.getTime()
    return Number.isNaN(time) ? '[invalid date]' : value.toISOString()
  }

  if (seen.has(value)) return CIRCULAR_MARKER
  if (depth >= MAX_SANITIZE_DEPTH) return '[max depth]'
  seen.add(value)
  try {
    if (value instanceof Error) return formatError(value, seen, depth)
    if (Array.isArray(value)) return value.map((item) => toLogSafe(item, seen, depth + 1))

    const out: Record<string, unknown> = {}
    for (const key of safeKeys(value)) {
      try {
        out[key] = toLogSafe((value as Record<string, unknown>)[key], seen, depth + 1)
      } catch {
        // A getter/Proxy that throws on read: keep the other fields, mark just this one.
        out[key] = '[unreadable]'
      }
    }

    return out
  } finally {
    seen.delete(value)
  }
}

// Reads one own property defensively (a getter may throw), returning undefined on failure.
const safeRead = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

// Formats one Error into a flat, JSON-safe record: message under `error`, plus stack, the common
// diagnostic detail keys, and a (recursively sanitized) cause. The caller must have already added
// `error` to `seen`, so a cause that points back to it becomes the circular marker rather than recursing.
const formatError = (error: Error, seen: Set<object>, depth: number): Record<string, unknown> => {
  const fields: Record<string, unknown> = {
    error: typeof error.message === 'string' ? error.message : String(safeRead(error, 'message')),
    stack: typeof error.stack === 'string' ? error.stack : undefined
  }

  for (const key of ERROR_DETAIL_KEYS) {
    const detail = safeRead(error, key)
    if (detail !== undefined) fields[key] = toLogSafe(detail, seen, depth + 1)
  }

  const cause = safeRead(error, 'cause')
  if (cause !== undefined) fields.cause = toLogSafe(cause, seen, depth + 1)

  return fields
}

// Best-effort message extraction used only when the full sanitizer itself fails — never throws.
const bestEffortMessage = (error: unknown): string => {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
    return String(error)
  } catch {
    return 'unserializable error'
  }
}

// Expands an unknown thrown value into a log-safe record for nesting inside a larger context object.
// toSerializable only unwraps a *top-level* Error; an Error nested inside `{ error, ...ctx }` serializes
// to `{}` because its fields are non-enumerable — losing the message, stack, and (worse) the code/data
// that name the real cause. Spread the result into the log context so all of it survives:
//   log.error('connect failed', { ...errorLogFields(err), framework })
// The result is guaranteed acyclic and JSON-serializable, and this function never throws: every branch
// runs through toLogSafe (which unwraps nested Errors, breaks any cycle — in a cause chain, in
// RequestError.data, or a directly-thrown object — bounds depth, and guards every property read), and an
// outer guard converts even a total failure into a fixed fallback rather than losing the caller's log
// line or masking the original error.
const errorLogFields = (error: unknown): Record<string, unknown> => {
  try {
    const seen = new Set<object>()

    if (error instanceof Error) {
      seen.add(error)

      return formatError(error, seen, 0)
    }

    // A thrown non-Error object (e.g. a JSON-RPC error `{ code, message, data }`): keep its own fields
    // rather than collapsing to "[object Object]" the way String() would.
    if (error !== null && typeof error === 'object') {
      seen.add(error)
      const safe: Record<string, unknown> = {}
      for (const key of safeKeys(error)) {
        try {
          safe[key] = toLogSafe((error as Record<string, unknown>)[key], seen, 1)
        } catch {
          safe[key] = '[unreadable]'
        }
      }
      const message = safeRead(error, 'message')

      return { error: typeof message === 'string' ? message : '[object]', ...safe }
    }

    return { error: String(error) }
  } catch {
    // The sanitizer itself failed (a deeply hostile getter/Proxy). Never throw into the caller's log
    // call — a degraded record beats a lost log line plus a masked original error.
    return { error: bestEffortMessage(error), serializationFailed: true }
  }
}

const formatLine = (level: LogLevel, scope: string, message: string, data?: unknown): string => {
  const record: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    scope,
    msg: message
  }

  if (data !== undefined) record.data = toSerializable(data)

  try {
    return JSON.stringify(record)
  } catch {
    // Fall back to a best-effort line if the payload has circular refs.
    return JSON.stringify({ t: record.t, level, scope, msg: message, data: '[unserializable]' })
  }
}

// The path of the i-th rotated backup (i >= 1): "main.log" -> "main.1.log".
const rotatedName = (fileName: string, index: number): string => {
  const ext = extname(fileName)
  const base = ext ? fileName.slice(0, -ext.length) : fileName

  return `${base}.${index}${ext}`
}

const fileSize = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

// Shifts the live file into backups, dropping any beyond `maxFiles`. Best-effort: a missing file at
// any step is ignored so logging never fails because of rotation.
const rotate = async (logDir: string, fileName: string, maxFiles: number): Promise<void> => {
  const path = (name: string): string => join(logDir, name)
  const backups = Math.max(0, maxFiles - 1)

  if (backups === 0) {
    // No backups kept: just drop the live file so a fresh one starts.
    await rm(path(fileName), { force: true }).catch(() => undefined)
    return
  }

  // Delete the oldest backup, then shift each backup up one slot, then the live file becomes .1.
  await rm(path(rotatedName(fileName, backups)), { force: true }).catch(() => undefined)

  for (let index = backups - 1; index >= 1; index -= 1) {
    await rename(path(rotatedName(fileName, index)), path(rotatedName(fileName, index + 1))).catch(
      () => undefined
    )
  }

  await rename(path(fileName), path(rotatedName(fileName, 1))).catch(() => undefined)
}

const appendLine = (line: string): void => {
  if (!config) return

  const { logDir, fileName, maxBytes, maxFiles } = config

  writeChain = writeChain.then(
    async () => {
      try {
        await mkdir(logDir, { recursive: true })

        const filePath = join(logDir, fileName)

        if (currentBytes === undefined) {
          currentBytes = await fileSize(filePath)
        }

        const lineBytes = Buffer.byteLength(line, 'utf8') + 1 // include the newline

        // Rotate before writing when the next line would exceed the cap (but never rotate an empty file).
        if (currentBytes > 0 && currentBytes + lineBytes > maxBytes) {
          await rotate(logDir, fileName, maxFiles)
          currentBytes = 0
        }

        await appendFile(filePath, `${line}\n`, 'utf8')
        currentBytes += lineBytes
      } catch {
        // Logging must never throw or reject into the app; a failed write is silently dropped.
      }
    },
    () => undefined
  )
}

// Initializes the sink. Safe to call once at startup; later calls replace the config and re-seed size.
const initLogger = (options: { logDir: string } & Partial<Omit<LoggerConfig, 'logDir'>>): void => {
  config = {
    fileName: 'main.log',
    minLevel: 'debug',
    mirrorToConsole: true,
    maxBytes: DEFAULT_MAX_BYTES,
    maxFiles: DEFAULT_MAX_FILES,
    ...options
  }
  currentBytes = undefined
}

// Absolute path of the active log file, or undefined before init. Used to reveal logs from the UI.
const getLogFilePath = (): string | undefined =>
  config ? join(config.logDir, config.fileName) : undefined

// Resolves once all queued writes have flushed. Useful for tests and orderly shutdown.
const flushLogs = (): Promise<void> => writeChain

const emit = (level: LogLevel, scope: string, message: string, data?: unknown): void => {
  const mirror = config?.mirrorToConsole ?? true

  if (mirror) {
    const consoleMethod = level === 'debug' ? 'log' : level
    console[consoleMethod](`[${scope}] ${message}`, data === undefined ? '' : toSerializable(data))
  }

  if (config && LEVEL_ORDER[level] < LEVEL_ORDER[config.minLevel]) return

  appendLine(formatLine(level, scope, message, data))
}

export type Logger = {
  debug: (message: string, data?: unknown) => void
  info: (message: string, data?: unknown) => void
  warn: (message: string, data?: unknown) => void
  error: (message: string, data?: unknown) => void
}

// Returns a logger bound to a scope label (e.g. "acp", "settings") that prefixes every record.
const createLogger = (scope: string): Logger => ({
  debug: (message, data) => emit('debug', scope, message, data),
  info: (message, data) => emit('info', scope, message, data),
  warn: (message, data) => emit('warn', scope, message, data),
  error: (message, data) => emit('error', scope, message, data)
})

export { createLogger, errorLogFields, flushLogs, formatLine, getLogFilePath, initLogger }
