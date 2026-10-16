import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
// Limits apply to input, retained cells, and the serialized report independently.
export const DATASET_LIMITS = {
  bytes: 8 * 1024 * 1024,
  rows: 10_000,
  columns: 128,
  cells: 200_000,
  fieldChars: 64 * 1024,
  previewChars: 128,
  reportBytes: 128 * 1024
} as const

export const inspectDatasetSchema = {
  path: z.string().min(1).max(4096),
  format: z.enum(['csv', 'tsv']).optional(),
  maxRows: z.number().int().min(1).max(DATASET_LIMITS.rows).optional(),
  previewRows: z.number().int().min(0).max(10).optional(),
  columns: z.array(z.string().min(1).max(256)).min(1).max(DATASET_LIMITS.columns).optional(),
  idColumn: z.string().min(1).max(256).optional(),
  missingValues: z.array(z.string().max(128)).max(16).optional()
}

const requestSchema = z.object(inspectDatasetSchema)
export type InspectDatasetInput = z.input<typeof requestSchema>
type Cell = string
type Table = {
  names: string[]
  rows: Cell[][]
  complete: boolean
  totalRows: number | null
  stopReason: 'eof' | 'row_limit' | 'byte_limit' | 'cell_limit'
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

// The caller derives roots from the authenticated session, never from tool arguments.
async function resolveSource(
  path: string,
  roots: readonly string[],
  storageRoot?: string
): Promise<string> {
  const canonicalRoots: string[] = []
  for (const root of roots) {
    try {
      const anchor = resolve(storageRoot ?? dirname(root))
      const target = resolve(root)
      if (!inside(anchor, target) || target === anchor) {
        throw new Error('Dataset root is outside trusted storage.')
      }
      let current = await realpath(anchor)
      for (const segment of relative(anchor, target).split(sep)) {
        current = join(current, segment)
        const entry = await lstat(current)
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error('Dataset root is not a trusted storage directory.')
        }
      }
      canonicalRoots.push(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const candidate of isAbsolute(path) ? [path] : roots.map((root) => resolve(root, path))) {
    let canonical: string
    try {
      canonical = await realpath(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!canonicalRoots.some((root) => inside(root, canonical))) {
      throw new Error('Dataset path is outside the current session read scope.')
    }
    if (!(await stat(canonical)).isFile()) throw new Error('Dataset must be a regular file.')
    return canonical
  }
  throw new Error('Dataset file not found in the current session read scope.')
}

// Parse logical records (including quoted newlines), never count physical lines as rows.
function readDelimited(text: string, delimiter: string, eof: boolean, maxRows: number): Table {
  const rows: string[][] = []
  let names: string[] | undefined
  let row: string[] = []
  let field = ''
  let quoted = false
  let closed = false
  let started = false
  let stopReason: Table['stopReason'] = eof ? 'eof' : 'byte_limit'
  let consumed = 0
  const finishField = (): void => {
    row.push(field)
    if (row.length > DATASET_LIMITS.columns)
      throw new Error('Dataset exceeds the 128-column limit.')
    field = ''
    closed = false
  }
  const finishRow = (): void => {
    finishField()
    if (!names) {
      names = row
      if (names.some((name) => !name.trim() || name.length > 256)) {
        throw new Error('Column names must be nonempty and at most 256 characters.')
      }
      if (new Set(names).size !== names.length)
        throw new Error('Duplicate column names are ambiguous.')
    } else {
      if (row.length !== names.length) {
        throw new Error(
          `Record ${rows.length + 2} has ${row.length} fields; expected ${names.length}.`
        )
      }
      rows.push(row)
    }
    row = []
    started = false
  }
  for (let i = 0; i < text.length; i++) {
    if (!started && row.length === 0 && names) {
      if (rows.length >= maxRows) {
        stopReason = 'row_limit'
        break
      }
      if ((rows.length + 1) * names.length > DATASET_LIMITS.cells) {
        stopReason = 'cell_limit'
        break
      }
    }
    const char = text[i]
    started = true
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else field += char
    } else if (char === delimiter) {
      finishField()
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++
      finishRow()
    } else if (char === '"' && field.length === 0 && !closed) {
      quoted = true
    } else {
      if (closed || char === '"') throw new Error('Malformed quoted field in dataset.')
      field += char
    }
    if (field.length > DATASET_LIMITS.fieldChars)
      throw new Error('Dataset field exceeds the 64 KiB character limit.')
    consumed = i + 1
  }
  const complete = eof && consumed === text.length
  if (complete) {
    if (quoted) throw new Error('Unterminated quoted field in dataset.')
    if (started) finishRow()
  }
  if (!names) throw new Error('Dataset header is empty or exceeds the read limit.')
  return { names, rows, complete, totalRows: complete ? rows.length : null, stopReason }
}

function numeric(value: Cell): number | null {
  if (!/^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null
  const number = Number(value)
  // A nonzero mantissa that underflows to zero cannot contribute reliable statistics.
  if (number === 0 && /[1-9]/.test(value.split(/[eE]/)[0])) return null
  return Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number))
    ? number
    : null
}

function report(table: Table, input: InspectDatasetInput): Record<string, unknown> {
  const requested = input.columns ?? []
  for (const name of [...requested, ...(input.idColumn ? [input.idColumn] : [])]) {
    if (!table.names.includes(name)) throw new Error(`Unknown dataset column: ${name}`)
  }
  const missingValues = input.missingValues ?? ['']
  const missing = (value: Cell): boolean => missingValues.includes(value)
  const columns = table.names.map((name, index) => {
    const values = table.rows.map((row) => row[index])
    const present = values.filter((value) => !missing(value))
    const types = new Set(
      present.map((value) => {
        if (numeric(value) !== null) return Number.isInteger(numeric(value)) ? 'integer' : 'number'
        return 'string'
      })
    )
    if (types.has('number')) types.delete('integer')
    const type = types.size === 0 ? 'unknown' : types.size === 1 ? [...types][0] : 'mixed'
    const numbers = present.flatMap((value): number[] => {
      const number = numeric(value)
      return number === null ? [] : [number]
    })
    return {
      name,
      type,
      typeSource: 'inspected_rows',
      ...(requested.includes(name) || name === input.idColumn
        ? {
            missingCount: values.length - present.length,
            numericCount: numbers.length,
            nonfiniteCount: 0,
            numericRange: numbers.length
              ? {
                  min: numbers.reduce((a, b) => (a < b ? a : b)),
                  max: numbers.reduce((a, b) => (a > b ? a : b))
                }
              : null,
            ...(name === input.idColumn
              ? {
                  // Exact original values: numeric-looking IDs and leading zeroes are never normalized.
                  duplicateIdCount: present.length - new Set(present).size
                }
              : {})
          }
        : {})
    }
  })
  let truncatedCells = 0
  const preview = table.rows.slice(0, input.previewRows ?? 5).map((row) =>
    row.map((value) => {
      if (value.length <= DATASET_LIMITS.previewChars) return value
      truncatedCells++
      return `${value.slice(0, DATASET_LIMITS.previewChars)}…`
    })
  )
  return {
    dimensions: { rows: table.totalRows, columns: table.names.length },
    inspection: {
      scope: table.complete ? 'complete' : 'sample',
      sampling: 'prefix',
      rowsInspected: table.rows.length,
      stopReason: table.stopReason,
      statisticsScope: 'inspected_rows',
      missingValues,
      valueEncoding:
        'CSV/TSV cells retain their original text. Numeric statistics exclude values outside the safe numeric range. Empty text is missing by default; other text tokens require missingValues.',
      duplicateIdDefinition: 'Nonmissing occurrences beyond the first, using exact values.',
      limitations:
        'Structural inspection only; does not establish scientific suitability. Prefix samples cannot establish whole-file quality.'
    },
    columns,
    preview: { rows: preview, truncatedCells, cellCharacterLimit: DATASET_LIMITS.previewChars }
  }
}

export async function inspectDataset(
  rawInput: InspectDatasetInput,
  roots: readonly string[],
  signal?: AbortSignal,
  storageRoot?: string
): Promise<Record<string, unknown>> {
  const input = requestSchema.parse(rawInput)
  signal?.throwIfAborted()
  const path = await resolveSource(input.path, roots, storageRoot)
  const format = input.format ?? extname(path).slice(1).toLowerCase()
  if (format !== 'csv' && format !== 'tsv')
    throw new Error('Unsupported dataset format; select CSV or TSV.')
  // No-follow also rejects a final-component symlink introduced after canonicalization.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('Dataset must be a regular file.')
    const currentPath = await resolveSource(path, roots, storageRoot)
    const current = await stat(currentPath)
    if (before.dev !== current.dev || before.ino !== current.ino) {
      throw new Error('Dataset path changed during inspection; retry on a stable file.')
    }
    const length = Math.min(before.size, DATASET_LIMITS.bytes)
    const buffer = new ArrayBuffer(length)
    const view = new Uint8Array(buffer)
    let bytesRead = 0
    while (bytesRead < length) {
      signal?.throwIfAborted()
      const chunk = await handle.read(
        view,
        bytesRead,
        Math.min(64 * 1024, length - bytesRead),
        bytesRead
      )
      if (!chunk.bytesRead)
        throw new Error('Dataset changed during inspection; retry on a stable file.')
      bytesRead += chunk.bytesRead
    }
    const eof = bytesRead === before.size
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: !eof })
    const table = readDelimited(text, format === 'tsv' ? '\t' : ',', eof, input.maxRows ?? 1000)
    signal?.throwIfAborted()
    const after = await handle.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('Dataset changed during inspection; retry on a stable file.')
    }
    const result = {
      format,
      fileBytes: before.size,
      bytesRead,
      limits: DATASET_LIMITS,
      ...report(table, input)
    }
    if (Buffer.byteLength(JSON.stringify(result)) > DATASET_LIMITS.reportBytes) {
      throw new Error('Dataset report exceeds the output limit; reduce previewRows.')
    }
    return result
  } finally {
    await handle.close()
  }
}
