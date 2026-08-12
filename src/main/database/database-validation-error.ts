import { createHash } from 'node:crypto'

type DatabaseValidationDiagnostic = {
  kind: string
  table?: string
  column?: string
  constraint?: string
  expected?: unknown
  actual?: unknown
}

type DatabaseValueSummary = { type: 'null' } | { type: 'string'; length: number; sha256: string }

const summarizeDatabaseValue = (value: string | null): DatabaseValueSummary =>
  value === null
    ? { type: 'null' }
    : {
        type: 'string',
        length: value.length,
        sha256: createHash('sha256').update(value, 'utf8').digest('hex')
      }

class DatabaseValidationError extends Error {
  readonly name = 'DatabaseValidationError'

  constructor(
    message: string,
    readonly data: DatabaseValidationDiagnostic
  ) {
    super(message)
  }
}

export { DatabaseValidationError, summarizeDatabaseValue }
export type { DatabaseValidationDiagnostic, DatabaseValueSummary }
