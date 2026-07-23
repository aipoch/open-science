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
// Upper bound on array elements walked per node. A real array can report length 2**32-1 (sparse), and a
// hostile Proxy can report anything — iterating it would block or OOM the main process, which the depth
// limit does not prevent. Beyond the cap we stop and append a truncation marker.
const MAX_ARRAY_ELEMENTS = 1000
// Upper bound on own keys walked per object node (a hostile ownKeys can enumerate very many).
const MAX_OBJECT_KEYS = 1000
// Per-string code-unit ceiling (UTF-16 `.length`, not bytes). Bounds any single field so one giant
// string (a huge Error message/stack, a base64 blob, a giant bigint) can't dominate the line.
const MAX_STRING_LENGTH = 8192
// Longest property NAME kept verbatim; longer keys are truncated with a unique suffix (see capKey).
const MAX_KEY_LENGTH = 256
// Global bound on total nodes produced per sanitize call. The per-array cap and depth limit bound a
// single path, but a shared DAG (a diamond re-expanded on every reference after seen.delete) can still
// blow up combinatorially — e.g. three nested Array(1000).fill(child) is ~3000 input refs but ~1e9
// output nodes. This budget is threaded through the whole traversal and, once spent, truncates.
const MAX_TOTAL_NODES = 10000
// Global bound on total emitted characters per sanitize call. The node budget bounds node COUNT; this
// bounds total SIZE, since node-count × per-string-cap alone would still allow a very large line.
const MAX_TOTAL_CHARS = 256 * 1024

// Mutable budget shared across one errorLogFields call: `nodes` bounds how many values are emitted,
// `chars` bounds their combined length — together they bound both the count and the size of the output
// regardless of reference sharing.
type Budget = { nodes: number; chars: number }

// Per-field code-unit cap only (no global budget); used by the outer fallback where no budget is live.
const truncate = (value: string): string =>
  value.length <= MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_STRING_LENGTH)}…[+${value.length - MAX_STRING_LENGTH} chars]`

// Applies the per-field cap AND the shared character budget to a string about to be emitted, charging
// the budget for what it keeps. Once the global budget is spent, further strings collapse to a short
// marker so the total line size stays bounded.
const chargeString = (value: string, budget: Budget): string => {
  if (budget.chars <= 0) return '…[truncated]'
  const capped = truncate(value)
  if (capped.length <= budget.chars) {
    budget.chars -= capped.length
    return capped
  }
  const kept = capped.slice(0, budget.chars)
  budget.chars = 0
  return `${kept}…[truncated]`
}

// Produces a bounded, unique output key, or undefined when the character budget can't afford one. A long
// key is first bounded (index-suffixed so two long keys sharing a prefix stay distinct), then made unique
// against `used` — which the caller seeds with the record's RESERVED output names (e.g. the aggregate
// "[truncated]" marker, and "error" at the top level) so an input key of the same name is disambiguated
// rather than silently overwriting (or being overwritten by) our own field. We never collapse a key to a
// shared truncation marker; if a unique key doesn't fit the remaining budget the caller stops and counts
// the rest as omitted. Charges the character budget for the key it returns and records it in `used`.
const capKey = (
  key: string,
  index: number,
  used: Set<string>,
  budget: Budget
): string | undefined => {
  const bounded = key.length <= MAX_KEY_LENGTH ? key : `${key.slice(0, MAX_KEY_LENGTH)}…#${index}`
  let candidate = bounded
  let dup = 0
  while (used.has(candidate)) {
    dup += 1
    candidate = `${bounded}#dup${dup}`
  }
  if (candidate.length > budget.chars) return undefined
  budget.chars -= candidate.length
  used.add(candidate)
  return candidate
}

// Sentinel distinguishing a property whose read *threw* (a hostile getter/Proxy) from one that is
// genuinely absent/undefined, so the former can be surfaced as "[unreadable]" instead of silently
// dropped. A module-private symbol so it can never collide with a real value.
const UNREADABLE = Symbol('unreadable')
const UNREADABLE_MARKER = '[unreadable]'

// A record with no prototype, so assigning a key literally named "__proto__" creates an own data field
// (a diagnostic value worth keeping) instead of mutating the object's prototype and vanishing.
const nullProtoRecord = (): Record<string, unknown> =>
  Object.create(null) as Record<string, unknown>

// Reads own-property keys defensively — an exotic Proxy can throw from its ownKeys trap. Returns
// undefined (not []) on failure so the caller can surface the node as "[unreadable]" rather than an
// empty object, distinguishing a hostile object from a genuinely empty one.
const safeKeys = (value: object): string[] | undefined => {
  try {
    return Object.keys(value)
  } catch {
    return undefined
  }
}

// Reads one own property defensively (a getter/Proxy may throw), returning the UNREADABLE sentinel on
// failure so callers can tell a throwing read apart from a genuine `undefined`.
const safeRead = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return UNREADABLE
  }
}

// String() can itself throw (a hostile Symbol.toPrimitive/toString); never let it escape. Also caps the
// result (per-field + global budget) so a hostile or just huge coercion can't produce an unbounded string.
const safeToString = (value: unknown, budget: Budget): string => {
  try {
    return chargeString(String(value), budget)
  } catch {
    return '[unstringifiable]'
  }
}

// Recursively converts any value into a JSON-safe, acyclic structure. Total: it never throws — any
// hostile trap (`instanceof`/getPrototypeOf, a throwing `.name`, ownKeys, a getter) degrades to a marker.
// `seen` holds the *ancestor path* only (entries are removed on the way back up), so a value referenced
// twice in sibling positions is kept both times — only a real back-reference to an ancestor becomes the
// circular marker. Error instances are unwrapped at every depth (their fields are non-enumerable, so a
// nested Error would otherwise serialize to `{}`); bigint/function/symbol are stringified since
// JSON.stringify cannot represent them.
const toLogSafe = (value: unknown, seen: Set<object>, depth: number, budget: Budget): unknown => {
  // Charge one node per value visited so total output is bounded across the whole traversal — this is
  // what stops a shared DAG from expanding combinatorially even though each single path is capped.
  if (budget.nodes <= 0) return '[truncated: budget exceeded]'
  budget.nodes -= 1

  const type = typeof value
  // A bigint can be astronomically large (10n ** 100000n); cap its textual form.
  if (type === 'bigint') return chargeString(`${value as bigint}n`, budget)
  if (type === 'symbol') return safeToString(value, budget)
  if (type === 'function') {
    // A function's `name` can be a throwing getter on an exotic object.
    const name = safeRead(value as object, 'name')
    const label = typeof name === 'string' && name ? name : 'anonymous'
    return chargeString(`[function ${label}]`, budget)
  }
  // Cap over-long strings so one field can't blow up the log line; other primitives pass through.
  if (type === 'string') return chargeString(value as string, budget)
  if (value === null || type !== 'object') return value

  try {
    if (value instanceof Date) {
      // Call the ORIGINAL prototype methods (not the instance's, which can be overridden to return a
      // bigint or a value with a throwing toJSON), and validate the result is a string.
      const time = Date.prototype.getTime.call(value)
      if (typeof time !== 'number' || Number.isNaN(time)) return '[invalid date]'
      const iso = Date.prototype.toISOString.call(value)
      // Charge the data-derived ISO string against the character budget like any other value string.
      return typeof iso === 'string' ? chargeString(iso, budget) : '[invalid date]'
    }

    if (seen.has(value as object)) return CIRCULAR_MARKER
    if (depth >= MAX_SANITIZE_DEPTH) return '[max depth]'
    seen.add(value as object)
    try {
      if (value instanceof Error) return formatError(value, seen, depth, budget)
      if (Array.isArray(value)) {
        // Build a fresh plain array by index rather than value.map: map respects Symbol.species (a
        // hijacked constructor could produce an object with a throwing toJSON) and a throwing index
        // getter would abort the whole map. Per-index safeRead degrades one element instead.
        const rawLength = safeRead(value as object, 'length')
        // A throwing length getter means the node itself is unreadable — surface that rather than
        // silently rendering an empty array.
        if (rawLength === UNREADABLE) return UNREADABLE_MARKER
        // A real array length is a non-negative integer; anything else is a hostile Proxy — don't trust
        // it enough to iterate.
        if (typeof rawLength !== 'number' || !Number.isInteger(rawLength) || rawLength < 0) {
          return UNREADABLE_MARKER
        }
        // Cap iteration so a huge (real sparse array or hostile) length can't hang/OOM the process.
        const cap = Math.min(rawLength, MAX_ARRAY_ELEMENTS)
        const items: unknown[] = []
        let index = 0
        let budgetHit = false
        for (; index < cap; index += 1) {
          if (budget.nodes <= 0) {
            budgetHit = true
            break
          }
          // Charge one unit for THIS slot before reading, so an element whose read throws (marker path,
          // which never enters toLogSafe) still costs budget — otherwise a shared array of throwing
          // getters could be re-expanded across a DAG for free.
          budget.nodes -= 1
          const raw = safeRead(value as object, String(index))
          items.push(
            raw === UNREADABLE ? UNREADABLE_MARKER : toLogSafe(raw, seen, depth + 1, budget)
          )
        }
        // One marker counting EVERY element we didn't emit — those skipped by the budget within the cap
        // AND those beyond the cap — so the two limits never overwrite each other or under-report.
        const omitted = rawLength - index
        if (omitted > 0) {
          items.push(budgetHit ? `[+${omitted} more, output truncated]` : `[+${omitted} more]`)
        }

        return items
      }

      const keys = safeKeys(value as object)
      if (keys === undefined) return UNREADABLE_MARKER
      const out = nullProtoRecord()
      // Reserve the aggregate-marker name so an input key literally named "[truncated]" is disambiguated
      // rather than overwriting (or being overwritten by) our own marker.
      const used = new Set<string>(['[truncated]'])
      // Cap the number of keys walked: Object.keys already materialized them, but processing an
      // unbounded count (hostile Proxy ownKeys) still needs a ceiling.
      const limit = Math.min(keys.length, MAX_OBJECT_KEYS)
      let processed = 0
      let objBudgetHit = false
      for (; processed < limit; processed += 1) {
        if (budget.nodes <= 0) {
          objBudgetHit = true
          break
        }
        // A unique bounded key must be affordable; if not, stop so the remainder is counted rather than
        // collapsing keys to a shared marker that overwrites earlier fields.
        const key = capKey(keys[processed], processed, used, budget)
        if (key === undefined) {
          objBudgetHit = true
          break
        }
        // Charge per slot (see the array note): a key whose read throws must still cost budget.
        budget.nodes -= 1
        const raw = safeRead(value as object, keys[processed])
        out[key] = raw === UNREADABLE ? UNREADABLE_MARKER : toLogSafe(raw, seen, depth + 1, budget)
      }
      // One marker counting all unprocessed keys (budget-skipped within the cap + beyond the cap).
      const omittedKeys = keys.length - processed
      if (omittedKeys > 0) {
        out['[truncated]'] = objBudgetHit
          ? `+${omittedKeys} keys omitted, output truncated`
          : `+${omittedKeys} more keys`
      }

      return out
    } finally {
      seen.delete(value as object)
    }
  } catch {
    // Any residual hostile trap (e.g. `instanceof` triggering a throwing getPrototypeOf): degrade this
    // node alone rather than propagating and dropping its readable siblings.
    return UNREADABLE_MARKER
  }
}

// Resolves a safeRead result for a value slot: throwing read → marker, genuinely absent → the caller's
// default, otherwise the (total) sanitized value.
const sanitizeSlot = (
  raw: unknown,
  seen: Set<object>,
  depth: number,
  absent: unknown,
  budget: Budget
): unknown => {
  if (raw === UNREADABLE) return UNREADABLE_MARKER
  if (raw === undefined) return absent
  return toLogSafe(raw, seen, depth, budget)
}

// Formats one Error into a flat, JSON-safe record: message under `error`, plus stack, the common
// diagnostic detail keys, and a (recursively sanitized) cause. The caller must have already added
// `error` to `seen`, so a cause that points back to it becomes the circular marker rather than recursing.
// Every field — message and stack included — is read through safeRead, and each detail/cause value runs
// through the total toLogSafe, so a single throwing accessor degrades just that field to "[unreadable]"
// while the other still-readable fields survive.
const formatError = (
  error: Error,
  seen: Set<object>,
  depth: number,
  budget: Budget
): Record<string, unknown> => {
  const rawMessage = safeRead(error, 'message')
  const rawStack = safeRead(error, 'stack')
  const fields: Record<string, unknown> = {
    // message + stack are capped: an Error can carry a multi-megabyte message or stack, which the node
    // budget (a count, not a size) would not bound.
    error:
      rawMessage === UNREADABLE
        ? UNREADABLE_MARKER
        : typeof rawMessage === 'string'
          ? chargeString(rawMessage, budget)
          : rawMessage === undefined
            ? ''
            : safeToString(rawMessage, budget),
    stack:
      rawStack === UNREADABLE
        ? UNREADABLE_MARKER
        : typeof rawStack === 'string'
          ? chargeString(rawStack, budget)
          : undefined
  }

  for (const key of ERROR_DETAIL_KEYS) {
    const detail = safeRead(error, key)
    if (detail !== undefined) fields[key] = sanitizeSlot(detail, seen, depth + 1, undefined, budget)
  }

  const cause = safeRead(error, 'cause')
  if (cause !== undefined) fields.cause = sanitizeSlot(cause, seen, depth + 1, undefined, budget)

  return fields
}

// Best-effort message extraction used only when the full sanitizer itself fails — never throws, and
// (per-field) capped so even the fallback can't emit an unbounded string.
const bestEffortMessage = (error: unknown): string => {
  try {
    if (error instanceof Error && typeof error.message === 'string') return truncate(error.message)
    return truncate(String(error))
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
// runs through toLogSafe (which unwraps nested Errors, breaks any cycle, bounds depth, and guards every
// property read), and an outer guard converts even a total failure into a fixed fallback.
//
// Bounded-output guarantee (and its limits): the *produced* record is bounded on both axes. A global
// node budget caps the total emitted-value COUNT regardless of reference sharing (no combinatorial DAG
// blowup). A global character budget caps the total SIZE contributed by variable-length text: every
// data-derived string — array/object values, property names, message, stack, coerced values, bigint and
// Date text — is charged against it (per-field caps are UTF-16 code units via String.length, not bytes).
// Fixed structural markers ([circular], [max depth], [unreadable], the node-exhaustion and aggregate
// omission markers, [invalid date], the fallback marker) are short constants that are NOT charged; they
// stay bounded because the node budget and the per-array/per-object caps bound how many can appear.
// Each container appends at most one *aggregate* omission marker (counting budget-skipped + beyond-cap
// items together); an individual element may itself already be a truncation marker when its own value
// ran the budget out, so a truncated container can contain both a per-element marker and the aggregate
// marker — different information, by design.
// What this does NOT promise is sub-linear time under an adversarial synchronous Proxy: `Object.keys`
// must enumerate the trap's full ownKeys result before we cap it, and a Proxy that materializes millions
// of keys (or a value that allocates a huge string) pays that cost in its own trap/allocation, which JS
// cannot preempt. In short: we never *amplify* the input and never emit unbounded output, but we cannot
// make reading a pathological host object cheaper than the host object already made itself.
const errorLogFields = (error: unknown): Record<string, unknown> => {
  try {
    const seen = new Set<object>()
    // One budget for the whole call, so total output is bounded even when the same node is referenced
    // (and thus re-expanded) many times across a shared DAG.
    const budget: Budget = { nodes: MAX_TOTAL_NODES, chars: MAX_TOTAL_CHARS }

    if (error instanceof Error) {
      seen.add(error)

      return formatError(error, seen, 0, budget)
    }

    // A thrown non-Error object (e.g. a JSON-RPC error `{ code, message, data }`): keep its own fields
    // rather than collapsing to "[object Object]" the way String() would.
    if (error !== null && typeof error === 'object') {
      seen.add(error)
      const keys = safeKeys(error)
      const message = safeRead(error, 'message')
      // The top-level message goes into `error` and must be capped like any other emitted string.
      const errorText =
        message === UNREADABLE
          ? UNREADABLE_MARKER
          : typeof message === 'string'
            ? chargeString(message, budget)
            : keys === undefined
              ? UNREADABLE_MARKER
              : '[object]'
      if (keys === undefined) return { error: errorText }
      const safe = nullProtoRecord()
      // Reserve the names this branch owns in the returned `{ error, ...safe }`: "error" (the message
      // summary) and the aggregate "[truncated]" marker. An input key of either name is disambiguated so
      // it can neither clobber the summary nor be clobbered by the marker.
      const used = new Set<string>(['error', '[truncated]'])
      const limit = Math.min(keys.length, MAX_OBJECT_KEYS)
      let processed = 0
      let objBudgetHit = false
      for (; processed < limit; processed += 1) {
        if (budget.nodes <= 0) {
          objBudgetHit = true
          break
        }
        // A unique bounded key must be affordable; otherwise stop and count the remainder rather than
        // collapsing keys to a shared marker.
        const key = capKey(keys[processed], processed, used, budget)
        if (key === undefined) {
          objBudgetHit = true
          break
        }
        // Charge per slot so an all-throwing-getter object still spends budget (marker path skips
        // toLogSafe), keeping a shared-DAG re-expansion bounded.
        budget.nodes -= 1
        const raw = safeRead(error, keys[processed])
        safe[key] = raw === UNREADABLE ? UNREADABLE_MARKER : toLogSafe(raw, seen, 1, budget)
      }
      const omittedKeys = keys.length - processed
      if (omittedKeys > 0) {
        safe['[truncated]'] = objBudgetHit
          ? `+${omittedKeys} keys omitted, output truncated`
          : `+${omittedKeys} more keys`
      }

      return { error: errorText, ...safe }
    }

    return { error: safeToString(error, budget) }
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
